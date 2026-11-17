# validation.py - customer data validation
import re

BSB_PATTERN = re.compile(r"^\d{3}-?\d{3}$")


def is_valid_bsb(bsb):
    """BSB is 6 digits, optionally written as 062-000."""
    if not isinstance(bsb, str):
        return False
    return bool(BSB_PATTERN.match(bsb.strip()))


def normalise_bsb(bsb):
    if not is_valid_bsb(bsb):
        raise ValueError("invalid BSB: %r" % bsb)
    digits = bsb.strip().replace("-", "")
    return digits[:3] + "-" + digits[3:]


def normalise_name(name):
    """Collapse whitespace and title-case, e.g. '  mary   o'neil ' -> "Mary O'Neil"."""
    return " ".join(name.split()).title()


def mask_account(account_number):
    """Show only the last 4 digits."""
    digits = "".join(ch for ch in str(account_number) if ch.isdigit())
    if len(digits) <= 4:
        return digits
    return "*" * (len(digits) - 4) + digits[-4:]


def check_digit(account_number):
    """Legacy mod-11 weighted check digit used by the old core."""
    weights = [3, 7, 9, 3, 7, 9, 3, 7]
    digits = [int(c) for c in str(account_number)][-8:]
    total = sum(d * w for d, w in zip(digits, weights))
    return (11 - total % 11) % 10
