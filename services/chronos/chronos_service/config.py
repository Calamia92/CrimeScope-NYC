from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    port: int

    clickhouse_host: str
    clickhouse_port: int
    clickhouse_database: str
    clickhouse_user: str
    clickhouse_password: str

    model_name: str

    default_history_weeks: int
    default_horizon_weeks: int
    max_history_weeks: int
    max_horizon_weeks: int
    min_history_points: int


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def load_settings() -> Settings:
    return Settings(
        port=_int("CHRONOS_PORT", 8000),
        clickhouse_host=os.environ.get("CLICKHOUSE_HOST", "clickhouse"),
        clickhouse_port=_int("CLICKHOUSE_HTTP_PORT", 8123),
        clickhouse_database=os.environ.get("CLICKHOUSE_DATABASE", "crimescope"),
        clickhouse_user=os.environ.get("CLICKHOUSE_USER", "crimescope"),
        clickhouse_password=os.environ.get("CLICKHOUSE_PASSWORD", "crimescope_password"),
        model_name=os.environ.get("CHRONOS_MODEL", "amazon/chronos-2"),
        default_history_weeks=_int("CHRONOS_DEFAULT_HISTORY_WEEKS", 104),
        default_horizon_weeks=_int("CHRONOS_DEFAULT_HORIZON_WEEKS", 8),
        max_history_weeks=_int("CHRONOS_MAX_HISTORY_WEEKS", 520),
        max_horizon_weeks=_int("CHRONOS_MAX_HORIZON_WEEKS", 52),
        min_history_points=_int("CHRONOS_MIN_HISTORY_POINTS", 12),
    )
