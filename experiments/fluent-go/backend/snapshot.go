package main

// Snapshot normalization: a pragmatic subset of churnrisk/snapshot.py.
// Accepts the canonical {accounts, services, transactions} shape,
// collection/field aliases and nested services inside accounts, and
// checks that services/transactions reference existing accounts.

import "fmt"

var collectionAliases = map[string][]string{
	"accounts":     {"accounts", "users", "customers", "clients"},
	"services":     {"services", "subscriptions"},
	"transactions": {"transactions", "payments"},
}

var fieldAliases = map[string][]string{
	"id":                {"id", "_id"},
	"email":             {"email", "email_address"},
	"accountId":         {"accountId", "account_id", "userId", "user_id", "customerId", "customer_id", "client_id"},
	"withdrawBalance":   {"withdrawBalance", "withdraw_balance"},
	"bonusBalance":      {"bonusBalance", "bonus_balance"},
	"bonusState":        {"bonusState", "bonus_state"},
	"totalReplenished":  {"totalReplenished", "total_replenished"},
	"paymentTerm":       {"paymentTerm", "payment_term", "billing_period"},
	"autoprolong":       {"autoprolong", "auto_renew", "autoRenew"},
	"expiresAt":         {"expiresAt", "expires_at", "expiration_date"},
	"deletedAt":         {"deletedAt", "deleted_at", "removedAt", "removed_at"},
}

func rowsFromAny(v any, path string) ([]map[string]any, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s: ожидался массив объектов", path)
	}
	rows := []map[string]any{}
	for i, item := range list {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s[%d]: ожидался объект", path, i)
		}
		rows = append(rows, applyAliases(row))
	}
	return rows, nil
}

func applyAliases(row map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range row {
		out[k] = v
	}
	for field, aliases := range fieldAliases {
		for _, alias := range aliases {
			if v, ok := row[alias]; ok {
				out[field] = v
				break
			}
		}
		for _, alias := range aliases {
			if alias != field {
				delete(out, alias)
			}
		}
	}
	return out
}

func pickCollection(source map[string]any, table string) ([]map[string]any, bool, error) {
	for _, alias := range collectionAliases[table] {
		if v, ok := source[alias]; ok {
			rows, err := rowsFromAny(v, table)
			return rows, true, err
		}
	}
	return nil, false, nil
}

func NormalizeSnapshot(raw map[string]any) (map[string][]map[string]any, error) {
	source := raw
	if wrapped, ok := raw["snapshot"].(map[string]any); ok {
		source = wrapped
	} else if wrapped, ok := raw["data"].(map[string]any); ok {
		source = wrapped
	}

	result := map[string][]map[string]any{}
	accountsFound := false
	for _, table := range []string{"accounts", "services", "transactions"} {
		rows, present, err := pickCollection(source, table)
		if err != nil {
			return nil, err
		}
		if table == "accounts" {
			accountsFound = present
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		result[table] = rows
	}
	if !accountsFound {
		return nil, fmt.Errorf("missing accounts collection: use accounts, users, customers or clients")
	}

	// Nested services/transactions inside account rows.
	for _, account := range result["accounts"] {
		owner := firstPresent(account, "id", "_id")
		for _, table := range []string{"services", "transactions"} {
			for _, alias := range collectionAliases[table] {
				nested, ok := account[alias]
				if !ok {
					continue
				}
				if owner == nil {
					return nil, fmt.Errorf("accounts: вложенные записи требуют id аккаунта")
				}
				rows, err := rowsFromAny(nested, "accounts."+table)
				if err != nil {
					return nil, err
				}
				for _, row := range rows {
					row["accountId"] = owner
					result[table] = append(result[table], row)
				}
				delete(account, alias)
			}
		}
	}

	// Referential integrity: services/transactions must point to accounts.
	accountIDs := map[string]bool{}
	for _, account := range result["accounts"] {
		accountIDs[strVal(firstPresent(account, "id", "_id"))] = true
	}
	for _, table := range []string{"services", "transactions"} {
		for _, row := range result[table] {
			owner := ownerOf(row)
			if owner != "" && !accountIDs[owner] {
				return nil, fmt.Errorf("%s: неизвестный аккаунт %s", table, owner)
			}
		}
	}
	return result, nil
}
