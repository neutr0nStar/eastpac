# fees.py - account fee schedule
from money import to_cents

FEE_SCHEDULE = {
    "basic": 500,      # $5.00 / month
    "premium": 1500,
    "student": 0,
}
WAIVE_ABOVE_CENTS = 500000  # balance >= $5k waives the monthly fee


def monthly_fee(balance_cents, tier="basic"):
    if tier not in FEE_SCHEDULE:
        raise KeyError("unknown tier: " + tier)
    if balance_cents >= WAIVE_ABOVE_CENTS:
        return 0
    return FEE_SCHEDULE[tier]


def days_overdue(due_day, today):
    """Days past the due day of a 30-day billing cycle (handles wrap-around)."""
    return (today - due_day) % 30


def weeks_between(start_day, end_day):
    """Whole weeks between two day numbers (can be negative)."""
    return (end_day - start_day) // 7


def late_fee(amount_dollars, days_late):
    """1.5% of the overdue amount per started week, capped at $35."""
    if days_late <= 0:
        return 0
    weeks = -(-days_late // 7)
    return min(to_cents(amount_dollars * 0.015 * weeks), 3500)
