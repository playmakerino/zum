/**
 * Google Ads → n8n webhook: gửi "remaining amount" của Account Budget.
 *
 * Áp dụng cho tài khoản dùng Monthly Invoicing / Consolidated invoice
 * (Billing → Account budgets). Công thức:
 *     remaining = adjusted_spending_limit_micros − amount_served_micros   (÷ 1e6)
 *
 * n8n nhận: workflow "Google Ads - Remaining Amount" (id QhJM8UbcCQNTZVEQ)
 *           Webhook (POST) → 2 Telegram. Phải để workflow ACTIVE.
 *
 * Cài đặt trong Google Ads:
 *   Tools → Bulk actions → Scripts → (+) → dán code này → Authorize → Save.
 *   Đặt Frequency = Daily (vd 11:00 giờ VN) để chạy tự động mỗi ngày.
 *   Bấm "Preview"/"Run" để test ngay.
 */

var WEBHOOK_URL = 'https://playmakerino.app.n8n.cloud/webhook/google-ads-remaining';

function main() {
  var query =
    'SELECT ' +
    'account_budget.name, ' +
    'account_budget.amount_served_micros, ' +
    'account_budget.adjusted_spending_limit_micros, ' +
    'account_budget.adjusted_spending_limit_type, ' +
    'account_budget.approved_start_date_time, ' +
    'customer.descriptive_name, ' +
    'customer.currency_code ' +
    'FROM account_budget ' +
    "WHERE account_budget.status = 'APPROVED'";

  var rows = AdsApp.search(query);

  // Nếu có nhiều budget APPROVED (cũ + hiện tại) → lấy cái bắt đầu gần nhất.
  var best = null;
  var customer = null;
  while (rows.hasNext()) {
    var row = rows.next();
    if (!customer) customer = row.customer;
    var b = row.accountBudget;
    if (!best || String(b.approvedStartDateTime) > String(best.approvedStartDateTime)) {
      best = b;
    }
  }

  if (!best) {
    Logger.log('Không có account budget APPROVED. Tài khoản có dùng monthly invoicing không?');
    return;
  }

  // Budget không giới hạn thì không có "số dư còn lại".
  if (best.adjustedSpendingLimitType && String(best.adjustedSpendingLimitType) !== 'FINITE') {
    Logger.log('Budget INFINITE → không có remaining.');
    return;
  }

  var limit = Number(best.adjustedSpendingLimitMicros) / 1e6;
  var spent = Number(best.amountServedMicros) / 1e6;
  var remaining = limit - spent;

  var payload = {
    account_name: customer.descriptiveName,
    currency: customer.currencyCode,
    budget_name: best.name,
    spending_limit: limit,
    amount_spent: spent,
    remaining_amount: remaining,
    percent_used: limit > 0 ? Math.round(spent / limit * 100) : 0
  };

  var resp = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  Logger.log('Đã gửi (HTTP ' + resp.getResponseCode() + '): remaining ' +
             remaining.toFixed(2) + ' ' + customer.currencyCode +
             ' (limit ' + limit.toFixed(2) + ', spent ' + spent.toFixed(2) + ')');
}
