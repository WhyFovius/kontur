package main

// HTTP API: same paths and payloads as the Python stack
// (see ../../../openapi.yaml), implemented on net/http only.

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	store        *Store
	adminUser    string
	adminPass    string
	cookieSecure bool
	limiter      *rateLimiter
	webDir       string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"detail": message})
}

func (s *Server) requireAuth(w http.ResponseWriter, r *http.Request) (string, bool) {
	username, ok := s.currentUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "Требуется вход")
		return "", false
	}
	return username, true
}

func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/v1/auth/me", s.handleMe)
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/providers", s.handleProviders)
	mux.HandleFunc("GET /api/v1/auth/oidc/login", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusServiceUnavailable, "OIDC не настроен в Go-эксперименте")
	})
	mux.HandleFunc("GET /api/v1/customers", s.handleCustomers)
	mux.HandleFunc("GET /api/v1/customers/{id}", s.handleCustomerDetail)
	mux.HandleFunc("GET /api/v1/analytics/summary", s.handleSummary)
	mux.HandleFunc("GET /api/v1/analytics/churn-timeline", s.handleTimeline)
	mux.HandleFunc("GET /api/v1/model/settings", s.handleGetSettings)
	mux.HandleFunc("PATCH /api/v1/model/settings", s.handlePatchSettings)
	mux.HandleFunc("PUT /api/v1/source/snapshot", s.handleSnapshot)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	mux.HandleFunc("GET /", s.handleStatic)
	return mux
}

// ---------- auth handlers ----------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&body); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "Некорректное тело запроса")
		return
	}
	key := clientKey(r)
	if limited, retryAfter := s.limiter.limited(key); limited {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeErr(w, http.StatusTooManyRequests, "Слишком много попыток входа. Повторите позже.")
		return
	}
	if !s.verifyAdmin(body.Username, body.Password) {
		s.limiter.fail(key)
		writeErr(w, http.StatusUnauthorized, "Неверный логин или пароль")
		return
	}
	s.limiter.clear(key)
	token, expires, err := s.store.CreateSession(s.adminUser)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Не удалось создать сессию")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: "churn_session", Value: token, Path: "/",
		HttpOnly: true, Secure: s.cookieSecure,
		SameSite: http.SameSiteLaxMode, MaxAge: 7 * 86400,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"username": s.adminUser, "expiresAt": expires.Format(time.RFC3339Nano),
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	username, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"username": username})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	if cookie, err := r.Cookie("churn_session"); err == nil {
		s.store.DeleteSession(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: "churn_session", Value: "", Path: "/",
		HttpOnly: true, Secure: s.cookieSecure,
		SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"password": s.adminPass != "",
		"oidc":     map[string]any{"enabled": false, "name": nil, "loginUrl": nil},
	})
}

// ---------- customers ----------

func compareCustomers(a, b map[string]any, sortKey string) int {
	switch sortKey {
	case "id":
		av, bv := strVal(a["id"]), strVal(b["id"])
		af, aErr := strconv.ParseFloat(av, 64)
		bf, bErr := strconv.ParseFloat(bv, 64)
		aNum, bNum := aErr == nil, bErr == nil
		if aNum && bNum {
			switch {
			case af < bf:
				return -1
			case af > bf:
				return 1
			}
			return 0
		}
		if aNum != bNum {
			if aNum {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(av), strings.ToLower(bv))
	case "email":
		return strings.Compare(
			strings.ToLower(strVal(a["email"])),
			strings.ToLower(strVal(b["email"])),
		)
	default:
		av, bv := num(a[sortKey]), num(b[sortKey])
		switch {
		case av < bv:
			return -1
		case av > bv:
			return 1
		}
		return 0
	}
}

func (s *Server) handleCustomers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	q := r.URL.Query()
	risk := q.Get("risk")
	if risk != "" && risk != "high" && risk != "medium" && risk != "low" && risk != "unrated" {
		writeErr(w, http.StatusUnprocessableEntity, "Неизвестный уровень риска")
		return
	}
	sortKey := q.Get("sort")
	if sortKey == "" {
		sortKey = "score"
	}
	switch sortKey {
	case "id", "email", "balance", "totalReplenished", "score":
	default:
		writeErr(w, http.StatusUnprocessableEntity, "Неизвестный ключ сортировки")
		return
	}
	order := q.Get("order")
	if order == "" {
		order = "desc"
	}
	if order != "asc" && order != "desc" {
		writeErr(w, http.StatusUnprocessableEntity, "Порядок сортировки: asc или desc")
		return
	}
	limit := 500
	if raw := q.Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > 1000 {
			writeErr(w, http.StatusUnprocessableEntity, "limit должен быть от 1 до 1000")
			return
		}
		limit = v
	}
	offset := 0
	if raw := q.Get("offset"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			writeErr(w, http.StatusUnprocessableEntity, "offset должен быть не меньше 0")
			return
		}
		offset = v
	}

	items := s.store.Analyzed()
	filtered := []map[string]any{}
	for _, c := range items {
		if risk == "" || strVal(c["riskLevel"]) == risk {
			filtered = append(filtered, c)
		}
	}
	rated := []map[string]any{}
	unrated := []map[string]any{}
	for _, c := range filtered {
		if c[sortKey] == nil {
			unrated = append(unrated, c)
		} else {
			rated = append(rated, c)
		}
	}
	sort.SliceStable(rated, func(i, j int) bool {
		cmp := compareCustomers(rated[i], rated[j], sortKey)
		if order == "desc" {
			return cmp > 0
		}
		return cmp < 0
	})
	sorted := append(rated, unrated...)
	total := len(sorted)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	page := []map[string]any{}
	for _, c := range sorted[offset:end] {
		page = append(page, PublicCustomer(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": page, "total": total})
}

func (s *Server) handleCustomerDetail(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	id := r.PathValue("id")
	for _, c := range s.store.Analyzed() {
		if strVal(c["id"]) == id {
			writeJSON(w, http.StatusOK, PublicCustomer(c))
			return
		}
	}
	writeErr(w, http.StatusNotFound, "Клиент не найден")
}

// ---------- analytics / model / source ----------

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	data := Summary(s.store.Analyzed())
	data["currency"] = "EUR"
	data["unit"] = "eurocents"
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, ChurnTimeline(s.store.Analyzed(), time.Now().UTC()))
}

func (s *Server) settingsPayload() map[string]any {
	return map[string]any{
		"weights":       s.store.Weights(),
		"features":      FeatureLabels(),
		"thresholds":    map[string]int{"medium": 35, "high": 65},
		"horizonMonths": 3,
	}
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.settingsPayload())
}

func (s *Server) handlePatchSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	var body struct {
		Weights map[string]float64 `json:"weights"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&body); err != nil || body.Weights == nil {
		writeErr(w, http.StatusUnprocessableEntity, "Ожидается объект weights")
		return
	}
	for key, value := range body.Weights {
		if !knownFeature(key) || value < 0 || value > 100 || math.IsNaN(value) {
			writeErr(w, http.StatusUnprocessableEntity, "Недопустимый вес признака: "+key)
			return
		}
	}
	if err := s.store.UpdateWeights(body.Weights); err != nil {
		writeErr(w, http.StatusInternalServerError, "Не удалось сохранить настройки")
		return
	}
	writeJSON(w, http.StatusOK, s.settingsPayload())
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAuth(w, r); !ok {
		return
	}
	var raw map[string]any
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "Снимок должен быть JSON-объектом")
		return
	}
	normalized, err := NormalizeSnapshot(raw)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err := s.store.ReplaceSnapshot(normalized); err != nil {
		writeErr(w, http.StatusInternalServerError, "Не удалось сохранить снимок")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"accounts":     len(normalized["accounts"]),
		"services":     len(normalized["services"]),
		"transactions": len(normalized["transactions"]),
	})
}

// ---------- metrics / static ----------

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	customers := s.store.Analyzed()
	data := Summary(customers)
	timeline := ChurnTimeline(customers, time.Now().UTC())
	totals, _ := timeline["totals"].(map[string]any)

	scoreSum, scoreCount := 0.0, 0
	for _, c := range customers {
		if c["score"] != nil {
			scoreSum += num(c["score"])
			scoreCount++
		}
	}
	averageScore := 0.0
	if scoreCount > 0 {
		averageScore = scoreSum / float64(scoreCount)
	}

	var b strings.Builder
	b.WriteString("# HELP churn_customers_total Customers by churn risk level\n")
	b.WriteString("# TYPE churn_customers_total gauge\n")
	fmt.Fprintf(&b, "churn_customers_total{risk=\"high\"} %v\n", data["highRisk"])
	fmt.Fprintf(&b, "churn_customers_total{risk=\"medium\"} %v\n", data["mediumRisk"])
	fmt.Fprintf(&b, "churn_customers_total{risk=\"low\"} %v\n", data["lowRisk"])
	fmt.Fprintf(&b, "churn_customers_total{risk=\"unrated\"} %v\n", data["unratedCount"])
	b.WriteString("# HELP churn_estimated_loss_eur Potential three-month revenue loss in euros\n")
	b.WriteString("# TYPE churn_estimated_loss_eur gauge\n")
	fmt.Fprintf(&b, "churn_estimated_loss_eur %.2f\n", num(data["estimatedLoss"])/100)
	b.WriteString("# HELP churn_monthly_revenue_at_risk_eur Risk-weighted monthly revenue in euros\n")
	b.WriteString("# TYPE churn_monthly_revenue_at_risk_eur gauge\n")
	fmt.Fprintf(&b, "churn_monthly_revenue_at_risk_eur %.2f\n", num(data["monthlyRevenueAtRisk"])/100)
	b.WriteString("# HELP churn_average_score Mean risk score of rated customers\n")
	b.WriteString("# TYPE churn_average_score gauge\n")
	fmt.Fprintf(&b, "churn_average_score %.2f\n", averageScore)
	b.WriteString("# HELP churn_services_at_risk Services awaiting payment or expiring without autoprolong\n")
	b.WriteString("# TYPE churn_services_at_risk gauge\n")
	fmt.Fprintf(&b, "churn_services_at_risk %v\n", data["atRiskServices"])
	fmt.Fprintf(&b, "churn_services_at_risk_30d %v\n", totals["servicesAtRisk30d"])
	fmt.Fprintf(&b, "churn_expected_nonrenewals_30d %.2f\n", num(totals["expectedNonRenewals30d"]))
	fmt.Fprintf(&b, "churn_deleted_services_90d %v\n", totals["deleted90d"])
	if forecast, ok := data["churnForecast"].(map[string]any); ok {
		days, _ := forecast["days"].([]int)
		counts, _ := forecast["counts"].([]int)
		for i := range days {
			if i < len(counts) {
				fmt.Fprintf(&b, "churn_forecast_services{horizon_days=\"%d\"} %d\n", days[i], counts[i])
			}
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, http.StatusNotFound, "Не найдено")
		return
	}
	indexPath := filepath.Join(s.webDir, "index.html")
	rel := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), string(filepath.Separator))
	if rel != "" && rel != "login" {
		candidate := filepath.Join(s.webDir, rel)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			http.ServeFile(w, r, candidate)
			return
		}
	}
	if _, err := os.Stat(indexPath); err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("Frontend is not built yet. Run: cd ../frontend && npm install && npm run build\n"))
		return
	}
	http.ServeFile(w, r, indexPath)
}
