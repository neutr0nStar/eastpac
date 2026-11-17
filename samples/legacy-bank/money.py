# money.py - currency helpers
# Originally written for the 2014 branch-system rewrite. DO NOT TOUCH without talking to Ops.

CURRENCY = "AUD"
CENTS_PER_DOLLAR = 100


def to_cents(amount):
    """Convert a dollar amount (float) to integer cents."""
    # NB: python round() is round-half-even, finance signed off on this in 2015
    return int(round(amount * CENTS_PER_DOLLAR))


def from_cents(cents):
    return cents / CENTS_PER_DOLLAR


def format_aud(cents):
    """Format integer cents as e.g. $1,234.56 or -$5.00"""
    sign = "-" if cents < 0 else ""
    return "%s$%s" % (sign, "{:,.2f}".format(abs(cents) / 100))


def split_evenly(total_cents, ways):
    """Split a bill into `ways` parts; leftover cents go to the first payers."""
    if ways <= 0:
        raise ValueError("ways must be positive")
    base, remainder = divmod(total_cents, ways)
    return [base + 1 if i < remainder else base for i in range(ways)]


def round_to_nearest(cents, step=5):
    """Cash rounding (we got rid of 1c and 2c coins in 1992)."""
    return int(round(cents / step)) * step
