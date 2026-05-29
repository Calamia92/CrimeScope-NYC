from __future__ import annotations

import math
from collections.abc import Sequence


def mae(actual: Sequence[float], predicted: Sequence[float]) -> float:
    return sum(abs(a - p) for a, p in zip(actual, predicted)) / len(actual)


def rmse(actual: Sequence[float], predicted: Sequence[float]) -> float:
    return math.sqrt(sum((a - p) ** 2 for a, p in zip(actual, predicted)) / len(actual))


def mape(actual: Sequence[float], predicted: Sequence[float]) -> float:
    # Standard MAPE undefined for actual == 0; we skip those points and return
    # the percentage over the remaining ones. Result is 0-100, not 0-1.
    pairs = [(a, p) for a, p in zip(actual, predicted) if a != 0]
    if not pairs:
        return 0.0
    return 100.0 * sum(abs(a - p) / abs(a) for a, p in pairs) / len(pairs)


def r2(actual: Sequence[float], predicted: Sequence[float]) -> float:
    mean = sum(actual) / len(actual)
    ss_tot = sum((a - mean) ** 2 for a in actual)
    ss_res = sum((a - p) ** 2 for a, p in zip(actual, predicted))
    # When the held-out window is flat, ss_tot collapses to 0 and R² is
    # undefined. Surface NaN so the caller can decide how to render it.
    if ss_tot == 0:
        return float("nan")
    return 1.0 - ss_res / ss_tot


def coverage(
    actual: Sequence[float],
    lower: Sequence[float],
    upper: Sequence[float],
) -> float:
    hits = sum(1 for a, lo, hi in zip(actual, lower, upper) if lo <= a <= hi)
    return hits / len(actual)
