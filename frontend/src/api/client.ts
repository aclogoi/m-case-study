import type {
  CaseInfo,
  ConditionalResponse,
  ExplainBatchRequest,
  ExplainBatchResponse,
  ExplainRequest,
  ExplainResponse,
  ReportedBooking,
  Scenario,
  SolveRequest,
  SolveResponse,
} from "./types";
import * as mock from "./mock";

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === "1";

export const BACKEND_START_COMMAND = "uv run uvicorn app.main:app --port 8010";

export class ApiError extends Error {
  /** `unreachable` is true when the backend did not answer at all (or the dev proxy could not reach it). */
  constructor(
    message: string,
    public status: number | null,
    public unreachable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function detailText(body: unknown): string | null {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    // FastAPI 422: a list of { loc, msg, type }
    if (Array.isArray(d)) {
      return d
        .map((x) => (x && typeof x === "object" && "msg" in x ? `${((x as { loc?: unknown[] }).loc ?? []).slice(1).join(".")}: ${(x as { msg: string }).msg}` : String(x)))
        .join("; ");
    }
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("The backend did not respond.", null, true);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON: the Vite proxy answers with plain text when the backend is down */
    }
    const detail = detailText(body);
    // The dev proxy returns 500/502/504 with no FastAPI body when nothing listens on 8010.
    const unreachable = detail === null && [500, 502, 503, 504].includes(res.status);
    const message =
      detail ??
      (unreachable
        ? "The backend did not respond."
        : `The API port answered with status ${res.status}, but not in the shape this backend uses. Another service may be holding the port.`);
    throw new ApiError(message, res.status, unreachable);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body), signal });

function fromMock<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof mock.MockHttpError) throw new ApiError(e.message, e.status, false);
    throw e;
  });
}

export function getCases(): Promise<CaseInfo[]> {
  return USE_MOCK ? fromMock(mock.mockCases()) : request<CaseInfo[]>("/api/cases");
}

export function getScenario(caseId: string): Promise<Scenario> {
  return USE_MOCK ? fromMock(mock.mockScenario(caseId)) : request<Scenario>(`/api/scenario?case_id=${encodeURIComponent(caseId)}`);
}

export function solve(req: SolveRequest, signal?: AbortSignal): Promise<SolveResponse> {
  return USE_MOCK ? fromMock(mock.mockSolve(req)) : post<SolveResponse>("/api/solve", req, signal);
}

export function explainAction(req: ExplainRequest, signal?: AbortSignal): Promise<ExplainResponse> {
  return USE_MOCK ? fromMock(mock.mockExplain(req)) : post<ExplainResponse>("/api/explain/action", req, signal);
}

/** Cost of refusing each action in the current plan (default: all of them). */
export function explainBatch(req: ExplainBatchRequest, signal?: AbortSignal): Promise<ExplainBatchResponse> {
  return USE_MOCK ? fromMock(mock.mockExplainBatch(req)) : post<ExplainBatchResponse>("/api/explain/batch", req, signal);
}

/** `GET /api/suggested-booking`: the Hartford correction for the default case (agreed addition to the contract). */
export function getSuggestedBooking(): Promise<ReportedBooking> {
  return USE_MOCK ? fromMock(mock.mockSuggestedBooking()) : request<ReportedBooking>("/api/suggested-booking");
}

function isPolicy(x: unknown): boolean {
  return !!x && typeof x === "object" && typeof (x as { expected_value?: unknown }).expected_value === "number" && typeof (x as { label?: unknown }).label === "string";
}

/** Set once the backend says the endpoint is not built (501/404/405), so it is asked only once per page load. */
let conditionalUnavailable = false;

/** Stretch. Resolves to null on any non-200 or unrecognised body, and the card is then hidden. */
export async function getConditional(req: SolveRequest): Promise<ConditionalResponse | null> {
  if (USE_MOCK || conditionalUnavailable) return null;
  try {
    const body = await post<unknown>("/api/conditional", req);
    const b = body as { haul_now?: unknown; incentive_first?: unknown };
    return isPolicy(b?.haul_now) && isPolicy(b?.incentive_first) ? (body as ConditionalResponse) : null;
  } catch (e) {
    if (e instanceof ApiError && e.status !== null && [404, 405, 501].includes(e.status)) conditionalUnavailable = true;
    return null;
  }
}
