export type Assertion =
  | { type: 'contains_text'; value: string }
  | { type: 'json_path_exists'; path: string }
  | { type: 'json_path_equals'; path: string; value: unknown };

export interface Monitor {
  userId: string;
  monitorId: string;
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  expectedStatus: number;
  timeoutMs: number;
  intervalMinutes: number;
  assertions: Assertion[];
  enabled: boolean;
  status: 'PENDING' | 'UP' | 'DEGRADED' | 'DOWN';
  failureStreak: number;
  activeIncidentId?: string;
  schedulePartition?: 'ACTIVE';
  nextCheckAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface CheckJob {
  jobId: string;
  userId: string;
  monitorId: string;
  requestedAt: string;
  source: 'scheduled' | 'manual';
}

export interface CheckResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  reason: string;
}
