-- Phase 1: Snowflake schema for the clean store and the simulated ACCOUNT_USAGE tables.
--
-- STATUS: written in standard Snowflake SQL but NOT executed against a live Snowflake account.
-- The test suite exercises the same logic in Node; treat this file as unverified until it is run.
--
-- Real SNOWFLAKE.ACCOUNT_USAGE views are read-only, so the simulated copies live in their own schema.
-- See docs/decisions.md (D5) for how they are derived and what their totals do and do not prove.

CREATE DATABASE IF NOT EXISTS PURE_INSIGHTS;
CREATE SCHEMA IF NOT EXISTS PURE_INSIGHTS.CORE;
CREATE SCHEMA IF NOT EXISTS PURE_INSIGHTS.SIM_ACCOUNT_USAGE;

-- One row per usable observation of a report (the CSV has 2,000 rows for 100 reports).
CREATE OR REPLACE TABLE PURE_INSIGHTS.CORE.OBSERVATIONS_CLEAN (
  observation_id             VARCHAR      NOT NULL PRIMARY KEY, -- RPT_200:001 = first observation of RPT_200
  source_row                 NUMBER(10,0) NOT NULL,             -- line number in the source CSV (header = line 1)
  report_id                  VARCHAR      NOT NULL,
  report_name                VARCHAR,
  owner_email                VARCHAR,                           -- NULL = orphan observation
  last_refresh_status        VARCHAR      NOT NULL,             -- SUCCESS | FAILED | TIMED_OUT | UNKNOWN
  monthly_active_views       NUMBER(10,0) NOT NULL,
  snowflake_credits_consumed NUMBER(12,2) NOT NULL,             -- never negative here; negatives are quarantined
  avg_load_time_sec          NUMBER(8,2)  NOT NULL,
  aws_hosting_cost_usd       NUMBER(12,2) NOT NULL,
  query_count_last_30d       NUMBER(12,0) NOT NULL,
  concurrent_user_peak       NUMBER(8,0)  NOT NULL,
  observed_at                TIMESTAMP_NTZ NOT NULL,            -- synthetic timeline, see decision D3
  is_orphan                  BOOLEAN      NOT NULL,
  orphan_kind                VARCHAR,                           -- MISSING | SENTINEL | INVALID
  status_unknown             BOOLEAN      NOT NULL,
  status_unrecognised        BOOLEAN      NOT NULL,
  zero_views                 BOOLEAN      NOT NULL,
  latency_breach             BOOLEAN      NOT NULL,             -- avg_load_time_sec > 15
  latency_at_ceiling         BOOLEAN      NOT NULL,             -- avg_load_time_sec >= 55
  concurrency_exceeds_views  BOOLEAN      NOT NULL
);

-- Rows removed from the clean store. Nothing is deleted: every excluded row is here with its reason.
CREATE OR REPLACE TABLE PURE_INSIGHTS.CORE.QUARANTINE_LEDGER (
  source_row    NUMBER(10,0) NOT NULL,
  report_id     VARCHAR,
  reason_codes  VARCHAR      NOT NULL, -- pipe-separated, e.g. NEGATIVE_CREDITS|NON_NUMERIC
  reason_detail VARCHAR,
  raw_record    VARCHAR      NOT NULL  -- the original line, for audit
);

-- One row per report. Feeds the orphaned-reports view.
CREATE OR REPLACE TABLE PURE_INSIGHTS.CORE.REPORTS (
  report_id                VARCHAR       NOT NULL PRIMARY KEY,
  report_name              VARCHAR,
  observation_count        NUMBER(6,0)   NOT NULL,
  first_observed_at        TIMESTAMP_NTZ NOT NULL,
  last_observed_at         TIMESTAMP_NTZ NOT NULL,
  last_refresh_status      VARCHAR       NOT NULL,
  current_owner_email      VARCHAR,
  last_known_owner_email   VARCHAR,
  is_orphaned              BOOLEAN       NOT NULL,
  orphan_observation_count NUMBER(6,0)   NOT NULL,
  distinct_owner_count     NUMBER(6,0)   NOT NULL
);

-- Tunable inputs for the cost suite (sql/10-14). One row.
--   credit_price_usd       PLACEHOLDER. Replace with the contracted $/credit before quoting any dollar figure.
--   variance_tolerance_pct a report is "reconciled" when attributed and reported credits differ by <= this %.
--   aws_mismatch_ratio     AWS cost per view this many times above (or below 1/x of) the fleet average is flagged.
CREATE OR REPLACE TABLE PURE_INSIGHTS.CORE.COST_PARAMS (
  credit_price_usd       NUMBER(10,4) NOT NULL,
  variance_tolerance_pct NUMBER(10,4) NOT NULL,
  aws_mismatch_ratio     NUMBER(10,4) NOT NULL
);
INSERT INTO PURE_INSIGHTS.CORE.COST_PARAMS VALUES (3.0, 10.0, 3.0);

-- Simulated SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY.
-- Deviation from the real view: pre-aggregated to ONE ROW PER REPORT PER HOUR (QUERY_COUNT queries,
-- TOTAL_ELAPSED_TIME summed), not one row per query. Reports are identified by QUERY_TAG = 'report:<id>'.
CREATE OR REPLACE TABLE PURE_INSIGHTS.SIM_ACCOUNT_USAGE.QUERY_HISTORY (
  query_id              VARCHAR       NOT NULL PRIMARY KEY,
  query_tag             VARCHAR       NOT NULL,
  warehouse_name        VARCHAR       NOT NULL,
  start_time            TIMESTAMP_NTZ NOT NULL,
  total_elapsed_time_ms NUMBER(18,0)  NOT NULL, -- query_count x avg_load_time_sec x 1000; independent of credits
  query_count           NUMBER(12,0)  NOT NULL,
  execution_status      VARCHAR       NOT NULL  -- SUCCESS | FAIL | FAIL_TIMEOUT | UNKNOWN
);

-- Simulated SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY (hourly credits per warehouse).
-- CREDITS_USED is the CSV credits summed per warehouse-hour, so totals match the CSV by construction.
CREATE OR REPLACE TABLE PURE_INSIGHTS.SIM_ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY (
  start_time                  TIMESTAMP_NTZ NOT NULL,
  end_time                    TIMESTAMP_NTZ NOT NULL,
  warehouse_id                NUMBER(4,0)   NOT NULL,
  warehouse_name              VARCHAR       NOT NULL,
  credits_used_compute        NUMBER(18,6)  NOT NULL,
  credits_used_cloud_services NUMBER(18,6)  NOT NULL, -- always 0: the source has no cloud-services split
  credits_used                NUMBER(18,6)  NOT NULL
);

-- Loading the generated files (run from SnowSQL; paths relative to data/processed):
--
--   CREATE OR REPLACE FILE FORMAT PURE_INSIGHTS.CORE.PI_CSV
--     TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"' NULL_IF = ('');
--   CREATE OR REPLACE STAGE PURE_INSIGHTS.CORE.PI_STAGE FILE_FORMAT = PURE_INSIGHTS.CORE.PI_CSV;
--   PUT file://observations_clean.csv @PURE_INSIGHTS.CORE.PI_STAGE;
--   COPY INTO PURE_INSIGHTS.CORE.OBSERVATIONS_CLEAN FROM @PURE_INSIGHTS.CORE.PI_STAGE/observations_clean.csv.gz;
--   (repeat PUT + COPY INTO for quarantine_ledger.csv, reports.csv, sim_query_history.csv,
--    sim_warehouse_metering_history.csv into their matching tables)
