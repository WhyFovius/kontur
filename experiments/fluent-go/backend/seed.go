package main

// Demo seed: the same 8 synthetic accounts as the Python stack, with
// relative expiry dates so the portfolio always looks alive.

import (
	"fmt"
	"time"
)

type seedPlan struct {
	status string
	price  int
	term   string
	auto   bool
	days   int
}

func SeedSnapshot(now time.Time) map[string][]map[string]any {
	type seedAccount struct {
		id                                      int
		email                                   string
		balance, withdraw, bonus, replenished   int
		bonusState                              bool
	}
	accounts := []seedAccount{
		{10482, "maria.volkova@example.com", 850, 1200, 0, 18400, false},
		{10817, "alexey.smirnov@example.com", 7200, 0, 900, 52800, true},
		{10931, "daria.ivanova@example.com", 90, 0, 0, 3200, false},
		{11004, "nikita.petrov@example.com", 16400, 600, 1400, 94300, true},
		{11276, "elena.orlova@example.com", 2100, 0, 350, 26100, true},
		{11509, "igor.sokolov@example.com", 0, 800, 0, 7900, false},
		{11642, "olga.kuznetsova@example.com", 4850, 0, 1200, 67100, true},
		{11803, "pavel.morozov@example.com", 360, 0, 100, 11600, true},
	}
	plans := [][]seedPlan{
		{{"active", 2400, "month", false, 2}, {"active", 900, "month", true, 34}},
		{{"active", 1800, "month", true, 25}, {"active", 4200, "quarter_year", true, 70}},
		{{"prolong_wait", 1600, "month", false, -2}, {"active", 650, "month", false, 9}},
		{{"active", 2200, "month", true, 50}, {"active", 6000, "year", true, 140}},
		{{"active", 3100, "month", false, 6}, {"deleted", 850, "month", false, -50}},
		{{"prolong_wait", 2800, "month", false, -4}},
		{{"active", 1200, "month", true, 19}, {"active", 3800, "half_year", true, 105}},
		{{"active", 950, "month", false, 3}, {"deleted", 400, "week", false, -35}},
	}
	names := []string{"Виртуальный сервер", "Резервное копирование", "Домашний сервер"}
	failedPayments := map[int]bool{10482: true, 10931: true, 11509: true}

	accountRows := []map[string]any{}
	serviceRows := []map[string]any{}
	transactionRows := []map[string]any{}
	for i, account := range accounts {
		accountRows = append(accountRows, map[string]any{
			"id": account.id, "email": account.email,
			"balance": account.balance, "withdrawBalance": account.withdraw,
			"bonusBalance": account.bonus, "bonusState": account.bonusState,
			"totalReplenished": account.replenished,
		})
		for index, plan := range plans[i] {
			serviceRows = append(serviceRows, map[string]any{
				"id":          fmt.Sprintf("svc-%d-%d", account.id, index+1),
				"accountId":   account.id,
				"name":        names[index%3],
				"status":      plan.status,
				"price":       plan.price,
				"paymentTerm": plan.term,
				"autoprolong": plan.auto,
				"expiresAt":   now.AddDate(0, 0, plan.days).UTC().Format(time.RFC3339),
			})
		}
		status := "performed"
		if failedPayments[account.id] {
			status = "not_performed"
		}
		transactionRows = append(transactionRows, map[string]any{
			"id":        fmt.Sprintf("pay-%d", account.id),
			"accountId": account.id,
			"status":    status,
			"type":      "prolong",
			"amount":    2400,
		})
	}
	return map[string][]map[string]any{
		"accounts":     accountRows,
		"services":     serviceRows,
		"transactions": transactionRows,
	}
}
