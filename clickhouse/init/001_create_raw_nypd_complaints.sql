CREATE DATABASE IF NOT EXISTS crimescope;

CREATE TABLE IF NOT EXISTS crimescope.raw_nypd_complaints
(
    complaint_number String,
    complaint_start_date Date,
    complaint_start_time Nullable(String),
    complaint_end_date Nullable(Date),
    complaint_end_time Nullable(String),
    report_datetime Nullable(DateTime64(3, 'UTC')),
    offense_code Nullable(UInt16),
    offense_category LowCardinality(String),
    offense_description Nullable(String),
    law_category Nullable(String),
    borough LowCardinality(Nullable(String)),
    precinct Nullable(UInt16),
    jurisdiction_description Nullable(String),
    location_of_occurrence Nullable(String),
    premise_description Nullable(String),
    latitude Nullable(Float64),
    longitude Nullable(Float64),
    h3_res_9 Nullable(UInt64),
    h3_res_7 Nullable(UInt64),
    source_dataset LowCardinality(String),
    source_record_url Nullable(String),
    source_row_checksum Nullable(String),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(complaint_start_date)
ORDER BY (complaint_start_date, complaint_number)
SETTINGS index_granularity = 8192;