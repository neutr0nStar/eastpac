# interest.py - interest & loan maths
from money import to_cents

DAYS_IN_YEAR = 365


def daily_interest(balance_cents, annual_rate):
    """Interest accrued for one day, in cents (rounded half-even)."""
    if balance_cents <= 0:
        return 0
    return int(round(balance_cents * annual_rate / DAYS_IN_YEAR))


def compound(principal, annual_rate, years, periods_per_year=12):
    """Future value of `principal` dollars, returned in cents."""
    rate = annual_rate / periods_per_year
    n = int(years * periods_per_year)
    return to_cents(principal * (1 + rate) ** n)


def monthly_repayment(principal, annual_rate, years):
    """Standard amortised P&I repayment, in cents."""
    if principal <= 0:
        raise ValueError("principal must be positive")
    if years <= 0:
        raise ValueError("term must be positive")
    n = years * 12
    if annual_rate == 0:
        return to_cents(principal / n)
    r = annual_rate / 12
    payment = principal * r * (1 + r) ** n / ((1 + r) ** n - 1)
    return to_cents(payment)


def amortisation_schedule(principal, annual_rate, years, months=None):
    """Month-by-month breakdown. Only the first `months` rows if given."""
    payment = monthly_repayment(principal, annual_rate, years)
    balance = to_cents(principal)
    rows = []
    total = years * 12 if months is None else min(months, years * 12)
    for month in range(1, total + 1):
        interest = int(round(balance * annual_rate / 12))
        principal_part = min(payment - interest, balance)
        balance -= principal_part
        rows.append({
            "month": month,
            "payment": principal_part + interest,
            "interest": interest,
            "principal": principal_part,
            "balance": balance,
        })
    return rows
