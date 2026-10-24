// Aéza - это быстрый хостинг
package main

// Domain layer: a faithful Go port of churnrisk/domain.py.
// Same features, same weights, same score/money math, so the v2 stack
// rates the demo portfolio identically to the Python backend.

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// ---------- generic JSON helpers (mirror Python dict semantics) ----------

func num(v any) float64 {
	switch n := v.(type) {
	case nil:
		return 0
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
			return 0
		}
		return n
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return 0
		}
		return num(f)
	case int:
		return num(float64(n))
	case int64:
		return num(float64(n))
	case bool:
		if n {
			return 1
		}
		return 0
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return 0
		}
		return num(f)
	}
	return 0
}

func strVal(v any) string {
	switch n := v.(type) {
	case nil:
		return ""
	case string:
		return n
	case json.Number:
		return n.String()
	case float64:
		if n == math.Trunc(n) && !math.IsInf(n, 0) {
			return strconv.FormatInt(int64(n), 10)
		}
		return strconv.FormatFloat(n, 'f', -1, 64)
	case int:
		return strconv.Itoa(n)
	case int64:
		return strconv.FormatInt(n, 10)
	case bool:
		if n {
			return "true"
		}
		return "false"
	}
	return fmt.Sprintf("%v", v)
}

func boolVal(v any) bool {
	b, _ := v.(bool)
	return b
}

func firstPresent(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func ownerOf(row map[string]any) string {
	return strVal(firstPresent(row, "accountId", "userId", "account_id"))
}

func statusOf(service map[string]any) string {
	return strings.ToLower(strVal(service["status"]))
}

func parseDate(v any) (time.Time, bool) {
	switch n := v.(type) {
	case nil:
		return time.Time{}, false
	case map[string]any:
		if inner, ok := n["$date"]; ok {
			return parseDate(inner)
		}
		if inner, ok := n["$numberLong"]; ok {
			return parseDate(inner)
		}
		return time.Time{}, false
	case float64:
		return unixFloat(n), true
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return time.Time{}, false
		}
		return unixFloat(f), true
	case int:
		return unixFloat(float64(n)), true
	case int64:
		return unixFloat(float64(n)), true
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return time.Time{}, false
		}
		layouts := []string{
			time.RFC3339Nano,
			"2006-01-02T15:04:05.999999999",
			"2006-01-02T15:04:05",
			"2006-01-02 15:04:05.999999999",
			"2006-01-02 15:04:05",
			"2006-01-02",
		}
		for _, layout := range layouts {
			if t, err := time.Parse(layout, s); err == nil {
				return t.UTC(), true
			}
		}
		return time.Time{}, false
	}
	return time.Time{}, false
}

func unixFloat(f float64) time.Time {
	if math.Abs(f) > 100_000_000_000 {
		return time.UnixMilli(int64(f)).UTC()
	}
	return time.Unix(int64(f), 0).UTC()
}

func daysUntil(t time.Time, now time.Time) float64 {
	return t.Sub(now).Hours() / 24
}

func formatMoneyCents(v float64) string {
	s := strconv.FormatFloat(v/100, 'f', 2, 64)
	parts := strings.SplitN(s, ".", 2)
	intPart := parts[0]
	frac := "00"
	if len(parts) == 2 {
		frac = parts[1]
	}
	neg := strings.HasPrefix(intPart, "-")
	if neg {
		intPart = intPart[1:]
	}
	var groups []string
	for len(intPart) > 3 {
		groups = append([]string{intPart[len(intPart)-3:]}, groups...)
		intPart = intPart[:len(intPart)-3]
	}
	groups = append([]string{intPart}, groups...)
	prefix := ""
	if neg {
		prefix = "-"
	}
	return prefix + strings.Join(groups, " ") + "," + frac + " €"
}

// ---------- features ----------

var paymentPeriods = map[string]float64{
	"hour":         730.5,
	"week":         365.25 / 7 / 12,
	"month":        1.0,
	"quarter_year": 1.0 / 3,
	"half_year":    1.0 / 6,
	"year":         1.0 / 12,
}

func paymentPeriod(term string) float64 {
	if p, ok := paymentPeriods[term]; ok {
		return p
	}
	return 1.0
}

var riskFactors = map[string]float64{"high": 0.80, "medium": 0.45, "low": 0.15}

func isBillable(service map[string]any) bool {
	st := statusOf(service)
	return st == "active" || st == "suspended"
}

func dueSoon(service map[string]any, now time.Time) bool {
	if statusOf(service) == "prolong_wait" {
		return true
	}
	expires, ok := parseDate(service["expiresAt"])
	return isBillable(service) && ok && daysUntil(expires, now) >= 0 && daysUntil(expires, now) <= 30
}

type featureCtx struct {
	services     []map[string]any
	transactions []map[string]any
	now          time.Time
	available    float64
	monthly      float64
	dueAmount    float64
}

type feature struct {
	key     string
	label   string
	def     float64
	active  func(*featureCtx) bool
	explain func(*featureCtx) string
}

var features = []feature{
	{
		key:   "expiring_without_autoprolong",
		label: "Скорое окончание без автопродления",
		def:   25,
		active: func(c *featureCtx) bool {
			for _, s := range c.services {
				expires, ok := parseDate(s["expiresAt"])
				if isBillable(s) && !boolVal(s["autoprolong"]) && ok &&
					daysUntil(expires, c.now) >= 0 && daysUntil(expires, c.now) <= 14 {
					return true
				}
			}
			return false
		},
		explain: func(c *featureCtx) string {
			return "Есть оплачиваемая услуга без автопродления со сроком окончания в ближайшие 14 дней."
		},
	},
	{
		key:   "insufficient_funds",
		label: "Не хватает средств на продление",
		def:   25,
		active: func(c *featureCtx) bool {
			hasDue := false
			for _, s := range c.services {
				if dueSoon(s, c.now) {
					hasDue = true
					break
				}
			}
			return hasDue && c.available < c.dueAmount
		},
		explain: func(c *featureCtx) string {
			missing := c.dueAmount - c.available
			if missing < 0 {
				missing = 0
			}
			return "На продления в ближайшие 30 дней не хватает " + formatMoneyCents(missing) + "."
		},
	},
	{
		key:   "prolong_wait",
		label: "Услуга ожидает оплаты",
		def:   25,
		active: func(c *featureCtx) bool {
			for _, s := range c.services {
				if statusOf(s) == "prolong_wait" {
					return true
				}
			}
			return false
		},
		explain: func(c *featureCtx) string {
			return "Услуга ожидает оплаты в течение пятидневного льготного периода."
		},
	},
	{
		key:   "failed_transactions",
		label: "Незавершённые платежи",
		def:   12,
		active: func(c *featureCtx) bool {
			for _, t := range c.transactions {
				if strings.ToLower(strVal(t["status"])) == "not_performed" {
					return true
				}
			}
			return false
		},
		explain: func(c *featureCtx) string {
			return "В снимке есть незавершённые транзакции."
		},
	},
	{
		key:   "deleted_services",
		label: "Удалённые услуги",
		def:   8,
		active: func(c *featureCtx) bool {
			if len(c.services) == 0 {
				return false
			}
			deleted := 0
			for _, s := range c.services {
				if statusOf(s) == "deleted" {
					deleted++
				}
			}
			return float64(deleted)/float64(len(c.services)) >= 0.3
		},
		explain: func(c *featureCtx) string {
			deleted := 0
			for _, s := range c.services {
				if statusOf(s) == "deleted" {
					deleted++
				}
			}
			return fmt.Sprintf("Удалено не менее 30%% услуг аккаунта (%d из %d).", deleted, len(c.services))
		},
	},
	{
		key:   "balance_pressure",
		label: "Высокая нагрузка на баланс",
		def:   5,
		active: func(c *featureCtx) bool {
			return c.monthly > 0 && c.available < c.monthly*2
		},
		explain: func(c *featureCtx) string {
			return "Доступного баланса меньше двух месяцев текущих платежей."
		},
	},
}

func DefaultWeights() map[string]float64 {
	out := map[string]float64{}
	for _, f := range features {
		out[f.key] = f.def
	}
	return out
}

func FeatureLabels() map[string]string {
	out := map[string]string{}
	for _, f := range features {
		out[f.key] = f.label
	}
	return out
}

func knownFeature(key string) bool {
	for _, f := range features {
		if f.key == key {
			return true
		}
	}
	return false
}

// ---------- analysis ----------

func servicesOf(customer map[string]any) []map[string]any {
	if services, ok := customer["services"].([]map[string]any); ok {
		return services
	}
	return nil
}

func Analyze(source map[string][]map[string]any, weights map[string]float64) []map[string]any {
	serviceMap := map[string][]map[string]any{}
	for _, s := range source["services"] {
		owner := ownerOf(s)
		serviceMap[owner] = append(serviceMap[owner], s)
	}
	transactionMap := map[string][]map[string]any{}
	for _, t := range source["transactions"] {
		owner := ownerOf(t)
		transactionMap[owner] = append(transactionMap[owner], t)
	}

	now := time.Now().UTC()
	norm := map[string]float64{}
	totalWeight := 0.0
	for _, f := range features {
		w, ok := weights[f.key]
		if !ok {
			w = f.def
		}
		w = num(w)
		norm[f.key] = w
		totalWeight += w
	}

	results := []map[string]any{}
	for _, account := range source["accounts"] {
		id := strVal(firstPresent(account, "id", "_id"))
		services := serviceMap[id]
		transactions := transactionMap[id]
		balance := num(account["balance"])
		bonus := 0.0
		if bs, ok := account["bonusState"].(bool); ok && bs {
			bonus = num(account["bonusBalance"])
		}
		available := balance + bonus
		email := strVal(account["email"])
		if email == "" {
			email = "—"
		}

		if len(services) == 0 && len(transactions) == 0 {
			results = append(results, map[string]any{
				"id": id, "email": email, "balance": balance,
				"availableBalance": available,
				"totalReplenished": num(account["totalReplenished"]),
				"score":            nil, "riskLevel": "unrated",
				"reasons":  []string{"Недостаточно данных: у аккаунта нет услуг и транзакций."},
				"services": []map[string]any{}, "features": map[string]bool{},
				"estimatedLoss": 0, "monthlyRevenue": 0, "daysToExpiry": nil,
			})
			continue
		}

		monthly := 0.0
		var monthlyServices []map[string]any
		for _, s := range services {
			if isBillable(s) {
				monthlyServices = append(monthlyServices, s)
				monthly += num(s["price"]) * paymentPeriod(strVal(firstPresentStr(s, "paymentTerm", "month")))
			}
		}
		dueAmount := 0.0
		for _, s := range services {
			if dueSoon(s, now) {
				dueAmount += num(s["price"])
			}
		}

		ctx := &featureCtx{
			services: services, transactions: transactions, now: now,
			available: available, monthly: monthly, dueAmount: dueAmount,
		}
		signals := map[string]bool{}
		weighted := 0.0
		reasons := []string{}
		for _, f := range features {
			on := f.active(ctx)
			signals[f.key] = on
			if on {
				weighted += norm[f.key]
				reasons = append(reasons, f.explain(ctx))
			}
		}
		score := 0
		if totalWeight > 0 {
			score = int(math.Round(100 * weighted / totalWeight))
		}
		level := "low"
		if score >= 65 {
			level = "high"
		} else if score >= 35 {
			level = "medium"
		}
		if len(reasons) == 0 {
			reasons = []string{"Критические сигналы риска не обнаружены."}
		}
		loss := math.Max(0, monthly*3-available) * riskFactors[level]

		var daysToExpiry any
		minDays := math.Inf(1)
		for _, s := range monthlyServices {
			if expires, ok := parseDate(s["expiresAt"]); ok {
				d := daysUntil(expires, now)
				if d < minDays {
					minDays = d
				}
			}
		}
		if !math.IsInf(minDays, 1) {
			daysToExpiry = math.Round(minDays*10) / 10
		}

		if services == nil {
			services = []map[string]any{}
		}
		results = append(results, map[string]any{
			"id": id, "email": email, "balance": balance,
			"availableBalance": available,
			"totalReplenished": num(account["totalReplenished"]),
			"score":            score, "riskLevel": level,
			"reasons": reasons, "services": services, "features": signals,
			"estimatedLoss":  int(math.Round(loss)),
			"monthlyRevenue": int(math.Round(monthly)),
			"daysToExpiry":   daysToExpiry,
		})
	}
	return results
}

func firstPresentStr(m map[string]any, key string, fallback string) string {
	if v, ok := m[key]; ok && v != nil {
		return strVal(v)
	}
	return fallback
}

var publicServiceFields = []string{
	"id", "name", "status", "price", "paymentTerm", "autoprolong", "expiresAt", "deletedAt",
}

func PublicCustomer(c map[string]any) map[string]any {
	services := []map[string]any{}
	for _, s := range servicesOf(c) {
		out := map[string]any{}
		for _, k := range publicServiceFields {
			if v, ok := s[k]; ok {
				out[k] = v
			}
		}
		services = append(services, out)
	}
	return map[string]any{
		"id": c["id"], "email": c["email"], "balance": c["balance"],
		"availableBalance": c["availableBalance"],
		"totalReplenished": c["totalReplenished"],
		"score":            c["score"], "riskLevel": c["riskLevel"],
		"reasons": c["reasons"], "services": services, "features": c["features"],
		"estimatedLoss": c["estimatedLoss"], "monthlyRevenue": c["monthlyRevenue"],
		"daysToExpiry": c["daysToExpiry"],
	}
}

// ---------- aggregates ----------

func Summary(customers []map[string]any) map[string]any {
	now := time.Now().UTC()
	atRisk, waiting := 0, 0
	var expiringDays []float64
	for _, c := range customers {
		for _, s := range servicesOf(c) {
			st := statusOf(s)
			expires, has := parseDate(s["expiresAt"])
			days := 0.0
			if has {
				days = daysUntil(expires, now)
			}
			expiring := isBillable(s) && has && days >= 0 && days <= 14 && !boolVal(s["autoprolong"])
			if st == "prolong_wait" || expiring {
				atRisk++
			}
			if st == "prolong_wait" {
				waiting++
			}
			if isBillable(s) && !boolVal(s["autoprolong"]) && has && days >= 0 && days <= 30 {
				expiringDays = append(expiringDays, days)
			}
		}
	}
	horizons := []int{0, 7, 14, 21, 30}
	counts := []int{}
	for _, h := range horizons {
		n := waiting
		for _, d := range expiringDays {
			if d <= float64(h) {
				n++
			}
		}
		counts = append(counts, n)
	}

	rated, high, medium, low := 0, 0, 0, 0
	estimatedLoss := 0.0
	monthlyAtRisk := 0.0
	for _, c := range customers {
		if c["score"] != nil {
			rated++
		}
		level := strVal(c["riskLevel"])
		switch level {
		case "high":
			high++
		case "medium":
			medium++
		case "low":
			low++
		}
		estimatedLoss += num(c["estimatedLoss"])
		monthlyAtRisk += num(c["monthlyRevenue"]) * riskFactors[level]
	}
	return map[string]any{
		"customerCount":        len(customers),
		"ratedCount":           rated,
		"unratedCount":         len(customers) - rated,
		"highRisk":             high,
		"mediumRisk":           medium,
		"lowRisk":              low,
		"estimatedLoss":        int(math.Round(estimatedLoss)),
		"monthlyRevenueAtRisk": int(math.Round(monthlyAtRisk)),
		"atRiskServices":       atRisk,
		"churnForecast":        map[string]any{"days": horizons, "counts": counts},
	}
}

type dayBucket struct {
	low, high float64
	label     string
}

var pastBuckets = []dayBucket{
	{-90, -61, "90–61 дн. назад"},
	{-60, -31, "60–31 дн. назад"},
	{-30, -1, "30–1 дн. назад"},
}

var futureBuckets = []dayBucket{
	{0, 7, "0–7 дн."},
	{8, 14, "8–14 дн."},
	{15, 30, "15–30 дн."},
	{31, 90, "31–90 дн."},
}

func bucketIndex(buckets []dayBucket, days float64) int {
	for i, b := range buckets {
		if days >= b.low && days <= b.high {
			return i
		}
	}
	return -1
}

func ChurnTimeline(customers []map[string]any, now time.Time) map[string]any {
	pastDeleted := make([]int, len(pastBuckets))
	futureAtRisk := make([]int, len(futureBuckets))
	futureExpected := make([]float64, len(futureBuckets))
	deletedTotal := 0

	for _, c := range customers {
		level := strVal(c["riskLevel"])
		factor := riskFactors[level]
		riskyOwner := level == "high" || level == "medium"
		for _, s := range servicesOf(c) {
			st := statusOf(s)
			if st == "deleted" {
				deletedTotal++
				deletedAt, ok := parseDate(s["deletedAt"])
				if !ok {
					deletedAt, ok = parseDate(s["expiresAt"])
				}
				if ok {
					if idx := bucketIndex(pastBuckets, daysUntil(deletedAt, now)); idx >= 0 {
						pastDeleted[idx]++
					}
				}
				continue
			}
			if st == "prolong_wait" {
				futureAtRisk[0]++
				futureExpected[0] += factor
				continue
			}
			if !isBillable(s) {
				continue
			}
			expires, ok := parseDate(s["expiresAt"])
			if !ok {
				continue
			}
			idx := bucketIndex(futureBuckets, daysUntil(expires, now))
			if idx < 0 {
				continue
			}
			if boolVal(s["autoprolong"]) && !riskyOwner {
				continue
			}
			futureAtRisk[idx]++
			futureExpected[idx] += factor
		}
	}

	past := []map[string]any{}
	for i, b := range pastBuckets {
		past = append(past, map[string]any{
			"label": b.label, "fromDays": int(b.low), "toDays": int(b.high),
			"deleted": pastDeleted[i],
		})
	}
	future := []map[string]any{}
	for i, b := range futureBuckets {
		future = append(future, map[string]any{
			"label": b.label, "fromDays": int(b.low), "toDays": int(b.high),
			"servicesAtRisk": futureAtRisk[i],
			"expectedNonRenewals": math.Round(futureExpected[i]*100) / 100,
		})
	}
	atRisk30 := futureAtRisk[0] + futureAtRisk[1] + futureAtRisk[2]
	expected30 := futureExpected[0] + futureExpected[1] + futureExpected[2]
	atRisk90, deleted90 := 0, 0
	expected90 := 0.0
	for _, n := range futureAtRisk {
		atRisk90 += n
	}
	for _, v := range futureExpected {
		expected90 += v
	}
	for _, n := range pastDeleted {
		deleted90 += n
	}
	return map[string]any{
		"generatedAt": now.UTC().Format(time.RFC3339),
		"past":        past,
		"future":      future,
		"totals": map[string]any{
			"deletedServices":         deletedTotal,
			"deleted90d":              deleted90,
			"servicesAtRisk30d":       atRisk30,
			"expectedNonRenewals30d":  math.Round(expected30*100) / 100,
			"servicesAtRisk90d":       atRisk90,
			"expectedNonRenewals90d":  math.Round(expected90*100) / 100,
		},
		"method": "Факт — услуги со статусом deleted по дате удаления (deletedAt, иначе expiresAt). " +
			"Прогноз — услуги под риском: prolong_wait и истекающие без автопродления или у клиентов " +
			"среднего/высокого риска; ожидаемые непродления взвешены коэффициентами риска 0,80 / 0,45 / 0,15.",
	}
}
