from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

import clickhouse_connect
from clickhouse_connect.driver.client import Client

from .config import Settings


@dataclass(frozen=True)
class WeeklyPoint:
    week: date
    count: int


class ClickHouseRepository:
    """Direct ClickHouse access for time-series queries.

    Keeps a single pooled HTTP client; clickhouse-connect handles connection
    reuse internally.
    """

    def __init__(self, settings: Settings) -> None:
        self._client: Client = clickhouse_connect.get_client(
            host=settings.clickhouse_host,
            port=settings.clickhouse_port,
            database=settings.clickhouse_database,
            username=settings.clickhouse_user,
            password=settings.clickhouse_password,
        )

    def close(self) -> None:
        self._client.close()

    def weekly_counts(
        self,
        borough: Optional[str] = None,
        offense: Optional[str] = None,
    ) -> list[WeeklyPoint]:
        """Returns weekly complaint counts ordered by week ascending.

        Filters mirror the main API's /analytics/by-date semantics:
        - borough: exact match, uppercased
        - offense: case-insensitive substring match on offense_description
        """
        where_parts: list[str] = ["complaint_start_date IS NOT NULL"]
        params: dict[str, object] = {}

        if borough:
            where_parts.append("borough = {borough:String}")
            params["borough"] = borough.upper()
        if offense:
            where_parts.append("offense_description ILIKE {offense:String}")
            params["offense"] = f"%{offense}%"

        sql = f"""
            SELECT
                toStartOfWeek(complaint_start_date, 1) AS week,
                count() AS count
            FROM raw_nypd_complaints
            WHERE {' AND '.join(where_parts)}
            GROUP BY week
            ORDER BY week ASC
        """

        result = self._client.query(sql, parameters=params)
        return [WeeklyPoint(week=row[0], count=int(row[1])) for row in result.result_rows]
