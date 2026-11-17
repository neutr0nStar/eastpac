# accounts.py - transaction account model
from money import to_cents, format_aud
from validation import normalise_name, normalise_bsb
from fees import monthly_fee


class InsufficientFunds(Exception):
    pass


class Account(object):
    """A simple transaction account. Balances held in integer cents."""

    def __init__(self, owner, bsb, tier="basic", overdraft_limit=0):
        self.owner = normalise_name(owner)
        self.bsb = normalise_bsb(bsb)
        self.tier = tier
        self.overdraft_limit = to_cents(overdraft_limit)
        self.balance_cents = 0
        self.history = []

    @property
    def balance(self):
        return format_aud(self.balance_cents)

    def deposit(self, amount):
        cents = to_cents(amount)
        if cents <= 0:
            raise ValueError("deposit must be positive")
        self.balance_cents += cents
        self.history.append(("DEP", cents))
        return self.balance_cents

    def withdraw(self, amount):
        cents = to_cents(amount)
        if cents <= 0:
            raise ValueError("withdrawal must be positive")
        if self.balance_cents - cents < -self.overdraft_limit:
            raise InsufficientFunds("insufficient funds")
        self.balance_cents -= cents
        self.history.append(("WDL", cents))
        return self.balance_cents

    def apply_monthly_fee(self):
        fee = monthly_fee(self.balance_cents, self.tier)
        if fee:
            self.balance_cents -= fee
            self.history.append(("FEE", fee))
        return fee

    def statement(self):
        lines = ["%s (%s)" % (self.owner, self.bsb)]
        for kind, cents in self.history:
            sign = "-" if kind in ("WDL", "FEE") else "+"
            lines.append("%s %s%s" % (kind, sign, format_aud(cents)))
        lines.append("Balance: " + self.balance)
        return "\n".join(lines)
