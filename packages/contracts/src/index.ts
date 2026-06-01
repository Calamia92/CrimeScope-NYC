export type ApiErrorResponse = {
  status?: "error";
  error?: string;
  message?: string;
};

export type HealthResponse = {
  status: "ok";
};

export type DbHealthResponse =
  | {
      status: "ok";
      database: "clickhouse";
    }
  | {
      status: "error";
      database: "clickhouse";
      message: string;
    };

export type DataHealthRecords = {
  total: number;
  minDate: string | null;
  maxDate: string | null;
  geocoded: number;
  geocodedPercent: number;
  unknownOffense: number;
  h3Res9Cells: number;
};

export type DataHealthAnalyticsMart = {
  weeklyRows: number;
  minWeek: string | null;
  maxWeek: string | null;
  latestRefresh: string | null;
};

export type DataHealthSource = {
  dataset: string;
  records: number;
  minDate: string | null;
  maxDate: string | null;
  geocoded: number;
  geocodedPercent: number;
};

export type IngestionRunSummary = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  dataset: string;
  status: string;
  requestedLimit: number;
  sourceRows: number;
  importedRows: number;
  skippedRows: number;
  geocodedRows: number;
  warningCount: number;
  durationMs: number;
  errorMessage: string | null;
  skippedReasons: Record<string, number>;
  warnings: Record<string, number>;
};

export type DataHealthResponse = {
  status: "ok";
  generatedAt: string;
  records: DataHealthRecords;
  analyticsMart: DataHealthAnalyticsMart;
  sources: DataHealthSource[];
  recentIngestionRuns: IngestionRunSummary[];
};

export type DateFilter = {
  from?: string;
  to?: string;
};

export type AnalyticsFilters = DateFilter & {
  borough?: string;
  offense?: string;
};

export type CrimeRecordsFilters = DateFilter & {
  borough?: string;
  offenseCategory?: string;
  precinct?: number;
};

export type CrimeRecord = {
  complaint_number: string;
  complaint_start_date: string;
  complaint_start_time: string | null;
  complaint_end_date: string | null;
  complaint_end_time: string | null;
  offense_category: string;
  borough: string | null;
  precinct: number | null;
  latitude: number | null;
  longitude: number | null;
  source_dataset: string;
};

export type CrimeRecordsResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  filters: CrimeRecordsFilters;
  items: CrimeRecord[];
};

export type H3Resolution = 7 | 9;

export type H3CellAggregation = {
  h3: string;
  count: number;
  lat: number;
  lng: number;
};

export type H3AggregationResponse = {
  resolution: H3Resolution;
  filters: AnalyticsFilters;
  cellCount: number;
  cells: H3CellAggregation[];
};

export type DateGranularity = "day" | "week" | "month";

export type DateBucket = {
  bucket: string;
  count: number;
};

export type ByDateResponse = {
  granularity: DateGranularity;
  filters: AnalyticsFilters;
  bucketCount: number;
  buckets: DateBucket[];
};

export type CategoryDimension = "offense_category" | "borough" | "law_category";

export type CategoryTotal = {
  key: string;
  count: number;
};

export type ByCategoryResponse = {
  dimension: CategoryDimension;
  filters: AnalyticsFilters;
  limit: number;
  totalGroups: number;
  totals: CategoryTotal[];
};

export type HourBucket = {
  hour: number;
  count: number;
};

export type ByHourResponse = {
  filters: AnalyticsFilters;
  buckets: HourBucket[];
};

export type WeekdayBucket = {
  weekday: number;
  label: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" | string;
  count: number;
};

export type ByWeekdayResponse = {
  filters: AnalyticsFilters;
  buckets: WeekdayBucket[];
};

export type WeeklyAnalyticsMartRow = {
  weekStart: string;
  borough: string;
  offenseCategory: string;
  complaintCount: number;
  geocodedCount: number;
  h3Res9Cells: number;
  refreshedAt: string;
};

export type WeeklyAnalyticsMartResponse = {
  filters: CrimeRecordsFilters;
  limit: number;
  rowCount: number;
  rows: WeeklyAnalyticsMartRow[];
};

export type PredictionRequest = DateFilter & {
  borough?: string;
  offenseCategory?: string;
  horizonDays: number;
  granularity: DateGranularity;
};

export type PredictionPoint = {
  date: string;
  predictedCount: number;
  lowerBound?: number;
  upperBound?: number;
};

export type PredictionResponse = {
  model: "chronos";
  generatedAt: string;
  filters: PredictionRequest;
  points: PredictionPoint[];
};
