"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { buildTeamAggregates } from "@/lib/teams/grouping";
import { runWithConcurrency } from "@/lib/utils/async";
import type {
  ApiError,
  ApiResponse,
  GuestReviewRecord,
  GuestStatus,
  LumaEventSummary,
  LumaGuestsPayload,
  TeamAggregate,
} from "@/lib/luma/types";

const STATUS_OPTIONS: Array<{ value: GuestStatus | "all"; label: string }> = [
  { value: "pending_approval", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
  { value: "invited", label: "Invited" },
  { value: "waitlist", label: "Waitlist" },
  { value: "session", label: "Session" },
  { value: "all", label: "All" },
];

type Tab = "teams" | "people";
type RegistrationFilter = "all" | "solo" | "team";
type TargetStatus = "approved" | "declined";

type Banner = {
  kind: "success" | "error" | "info";
  message: string;
};

type ConfirmState =
  | {
      scope: "team";
      team: TeamAggregate;
      status: TargetStatus;
      shouldRefund: boolean;
      submitting: boolean;
    }
  | {
      scope: "guest";
      guest: GuestReviewRecord;
      status: TargetStatus;
      shouldRefund: boolean;
      submitting: boolean;
    }
  | null;

function cn(...tokens: Array<string | false | null | undefined>): string {
  return tokens.filter(Boolean).join(" ");
}

async function parseApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();

  if (!text) {
    if (response.ok) {
      return {
        ok: true,
        data: {} as T,
      };
    }

    return {
      ok: false,
      error: {
        message: `Request failed with status ${response.status}`,
        status: response.status,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        message: "Failed to parse server response.",
        status: response.status,
      },
    };
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "ok" in parsed &&
    typeof (parsed as { ok?: unknown }).ok === "boolean"
  ) {
    return parsed as ApiResponse<T>;
  }

  if (response.ok) {
    return {
      ok: true,
      data: parsed as T,
    };
  }

  return {
    ok: false,
    error: {
      message: `Request failed with status ${response.status}`,
      status: response.status,
      details: parsed,
    },
  };
}

function statusBadge(status: GuestStatus): string {
  switch (status) {
    case "approved":
      return "bg-blue-500/15 text-blue-400 border-blue-500/25";
    case "declined":
      return "bg-red-500/12 text-red-400 border-red-500/20";
    case "pending_approval":
      return "bg-amber-500/12 text-amber-400 border-amber-500/20";
    case "waitlist":
      return "bg-purple-500/12 text-purple-400 border-purple-500/20";
    case "invited":
      return "bg-sky-500/12 text-sky-400 border-sky-500/20";
    case "session":
      return "bg-zinc-500/15 text-zinc-400 border-zinc-500/20";
    default:
      return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
  }
}

function shortText(value: string | null | undefined, maxLength = 88): string {
  if (!value) {
    return "-";
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

function isSolo(record: GuestReviewRecord): boolean {
  return record.isSoloRegistrant;
}

function matchesSearch(record: GuestReviewRecord, searchTerm: string): boolean {
  if (!searchTerm.trim()) {
    return true;
  }

  const query = searchTerm.trim().toLowerCase();
  const haystack = [
    record.name,
    record.email,
    record.teamNameRaw,
    record.normalizedAnswers.buildIdea,
    record.normalizedAnswers.affiliation,
    record.normalizedAnswers.github,
    record.normalizedAnswers.linkedin,
    record.normalizedAnswers.twitterX,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function matchesRegistrationFilter(
  record: GuestReviewRecord,
  filter: RegistrationFilter,
): boolean {
  if (filter === "all") {
    return true;
  }

  if (filter === "solo") {
    return isSolo(record);
  }

  return !isSolo(record);
}

function buildGuestStatusPayload(
  status: TargetStatus,
  shouldRefund: boolean,
): { status: TargetStatus; shouldRefund?: boolean } {
  if (status === "declined") {
    return {
      status,
      shouldRefund,
    };
  }

  return { status };
}

/* ─── Sub-components ─── */

function InlineMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 transition-colors hover:border-[var(--accent)]/20">
      <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-0.5 font-display text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ErrorPanel({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm">
      <p className="font-medium text-red-400">Unable to load data</p>
      <p className="mt-1 text-red-400/70">{error}</p>
      <button
        type="button"
        className="mt-2.5 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

function BannerNotice({ banner }: { banner: Banner }) {
  const tone =
    banner.kind === "success"
      ? "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-400"
      : banner.kind === "error"
        ? "border-red-500/25 bg-red-500/[0.06] text-red-400"
        : "border-blue-500/25 bg-blue-500/[0.06] text-blue-400";

  return (
    <div className={cn("rounded-lg border px-4 py-2.5 text-sm", tone)}>{banner.message}</div>
  );
}

function DetailItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-0.5 break-words text-sm text-[var(--text-secondary)]">
        {value || "\u2014"}
      </p>
    </div>
  );
}

/* ─── Shared styles ─── */

const selectClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-40";

const inputClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)] placeholder:text-[var(--text-muted)]";

/* ─── Main component ─── */

export default function LumaDashboard() {
  const [events, setEvents] = useState<LumaEventSummary[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [showAllEvents, setShowAllEvents] = useState(false);
  const [selectedEventApiId, setSelectedEventApiId] = useState<string | null>(null);

  const [guests, setGuests] = useState<GuestReviewRecord[]>([]);
  const [guestsLoading, setGuestsLoading] = useState(false);
  const [guestsRefreshing, setGuestsRefreshing] = useState(false);
  const [guestsError, setGuestsError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>("teams");
  const [approvalFilter, setApprovalFilter] = useState<GuestStatus | "all">("pending_approval");
  const [registrationFilter, setRegistrationFilter] = useState<RegistrationFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [includeSoloTeams, setIncludeSoloTeams] = useState(false);

  const [selectedGuestApiId, setSelectedGuestApiId] = useState<string | null>(null);
  const [selectedTeamKey, setSelectedTeamKey] = useState<string | null>(null);

  const [confirmState, setConfirmState] = useState<ConfirmState>(null);

  const [pendingGuestIds, setPendingGuestIds] = useState<Record<string, boolean>>({});
  const [pendingTeamKey, setPendingTeamKey] = useState<string | null>(null);

  const [banner, setBanner] = useState<Banner | null>(null);

  const visibleEvents = useMemo(() => {
    if (showAllEvents) {
      return events;
    }

    const hackathonOnly = events.filter((event) => event.isHackathonLike);
    return hackathonOnly.length ? hackathonOnly : events;
  }, [events, showAllEvents]);

  const selectedEvent = useMemo(() => {
    if (!selectedEventApiId) {
      return null;
    }

    return events.find((event) => event.eventApiId === selectedEventApiId) ?? null;
  }, [events, selectedEventApiId]);

  const filteredGuests = useMemo(() => {
    return guests.filter((guest) => {
      return (
        matchesSearch(guest, searchTerm) &&
        matchesRegistrationFilter(guest, registrationFilter)
      );
    });
  }, [guests, registrationFilter, searchTerm]);

  const teams = useMemo(() => {
    return buildTeamAggregates(filteredGuests, {
      includeSolo: includeSoloTeams,
    });
  }, [filteredGuests, includeSoloTeams]);

  const selectedGuest = useMemo(() => {
    if (!selectedGuestApiId) {
      return null;
    }

    return filteredGuests.find((guest) => guest.apiId === selectedGuestApiId) ?? null;
  }, [filteredGuests, selectedGuestApiId]);

  const selectedTeam = useMemo(() => {
    if (!selectedTeamKey) {
      return null;
    }

    return teams.find((team) => team.key === selectedTeamKey) ?? null;
  }, [selectedTeamKey, teams]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);

    try {
      const response = await fetch("/api/luma/events", {
        method: "GET",
        cache: "no-store",
      });

      const payload = await parseApiResponse<{ events: LumaEventSummary[] }>(response);

      if (!payload.ok) {
        throw new Error(payload.error.message);
      }

      setEvents(payload.data.events);
      setSelectedEventApiId((current) => {
        if (current && payload.data.events.some((event) => event.eventApiId === current)) {
          return current;
        }

        return payload.data.events[0]?.eventApiId ?? null;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load events.";
      setEventsError(message);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const loadGuests = useCallback(
    async (mode: "load" | "refresh" = "load") => {
      if (!selectedEvent) {
        setGuests([]);
        return;
      }

      if (mode === "load") {
        setGuestsLoading(true);
      } else {
        setGuestsRefreshing(true);
      }

      setGuestsError(null);

      try {
        const params = new URLSearchParams({
          eventId: selectedEvent.eventId,
          approvalStatus: approvalFilter,
        });

        const response = await fetch(
          `/api/luma/events/${encodeURIComponent(selectedEvent.eventApiId)}/guests?${params.toString()}`,
          {
            method: "GET",
            cache: "no-store",
          },
        );

        const payload = await parseApiResponse<LumaGuestsPayload>(response);

        if (!payload.ok) {
          throw new Error(payload.error.message);
        }

        setGuests(payload.data.guests);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load guests.";
        setGuestsError(message);
      } finally {
        if (mode === "load") {
          setGuestsLoading(false);
        } else {
          setGuestsRefreshing(false);
        }
      }
    },
    [approvalFilter, selectedEvent],
  );

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (!selectedEvent) {
      return;
    }

    setSelectedGuestApiId(null);
    setSelectedTeamKey(null);
    void loadGuests("load");
  }, [loadGuests, selectedEvent]);

  const setGuestPending = useCallback((guestApiId: string, pending: boolean) => {
    setPendingGuestIds((current) => {
      if (pending) {
        return {
          ...current,
          [guestApiId]: true,
        };
      }

      const next = { ...current };
      delete next[guestApiId];
      return next;
    });
  }, []);

  const updateGuestStatus = useCallback(
    async (
      guest: GuestReviewRecord,
      status: TargetStatus,
      shouldRefund: boolean,
      refreshAfter = true,
    ): Promise<{ ok: true } | { ok: false; error: ApiError["error"] }> => {
      if (!selectedEvent) {
        return {
          ok: false,
          error: {
            message: "No event selected.",
            status: 400,
          },
        };
      }

      try {
        setGuestPending(guest.apiId, true);

        const payload = buildGuestStatusPayload(status, shouldRefund);

        const response = await fetch(
          `/api/luma/events/${encodeURIComponent(selectedEvent.eventApiId)}/guests/${encodeURIComponent(guest.apiId)}/status`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        const apiResponse = await parseApiResponse<Record<string, never>>(response);

        if (!apiResponse.ok) {
          return {
            ok: false,
            error: apiResponse.error,
          };
        }

        if (refreshAfter) {
          await loadGuests("refresh");
        }

        return { ok: true };
      } finally {
        setGuestPending(guest.apiId, false);
      }
    },
    [loadGuests, selectedEvent, setGuestPending],
  );

  const onGuestApprove = useCallback(
    async (guest: GuestReviewRecord) => {
      setBanner(null);
      const result = await updateGuestStatus(guest, "approved", false, true);

      if (!result.ok) {
        setBanner({ kind: "error", message: result.error.message });
        return;
      }

      setBanner({
        kind: "success",
        message: `Approved ${guest.name}.`,
      });
    },
    [updateGuestStatus],
  );

  const onGuestDecline = useCallback((guest: GuestReviewRecord) => {
    setConfirmState({
      scope: "guest",
      guest,
      status: "declined",
      shouldRefund: false,
      submitting: false,
    });
  }, []);

  const onTeamAction = useCallback((team: TeamAggregate, status: TargetStatus) => {
    setConfirmState({
      scope: "team",
      team,
      status,
      shouldRefund: false,
      submitting: false,
    });
  }, []);

  const executeTeamUpdate = useCallback(
    async (team: TeamAggregate, status: TargetStatus, shouldRefund: boolean) => {
      const candidates = team.members.filter((member) => member.approvalStatus !== status);

      if (!candidates.length) {
        setBanner({
          kind: "info",
          message: `No updates needed for ${team.displayName}.`,
        });
        return;
      }

      setPendingTeamKey(team.key);
      setBanner(null);

      try {
        const results = await runWithConcurrency(candidates, 3, async (member) => {
          const result = await updateGuestStatus(member, status, shouldRefund, false);

          if (!result.ok) {
            return {
              ok: false,
              guest: member,
              message: result.error.message,
            };
          }

          return {
            ok: true,
            guest: member,
          };
        });

        await loadGuests("refresh");

        const failures = results.filter(
          (result): result is { ok: false; guest: GuestReviewRecord; message: string } =>
            !result.ok,
        );

        if (!failures.length) {
          setBanner({
            kind: "success",
            message: `${status === "approved" ? "Approved" : "Declined"} ${candidates.length} attendee${candidates.length === 1 ? "" : "s"} in ${team.displayName}.`,
          });
          return;
        }

        setBanner({
          kind: "error",
          message: `Updated ${candidates.length - failures.length}/${candidates.length} attendees in ${team.displayName}. ${failures.length} failed. First error: ${failures[0].message}`,
        });
      } finally {
        setPendingTeamKey(null);
      }
    },
    [loadGuests, updateGuestStatus],
  );

  const onConfirmAction = useCallback(async () => {
    if (!confirmState) {
      return;
    }

    setConfirmState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        submitting: true,
      };
    });

    if (confirmState.scope === "guest") {
      const { guest, status, shouldRefund } = confirmState;
      const result = await updateGuestStatus(guest, status, shouldRefund, true);

      if (result.ok) {
        setBanner({
          kind: "success",
          message: `${status === "approved" ? "Approved" : "Declined"} ${guest.name}.`,
        });
      } else {
        setBanner({ kind: "error", message: result.error.message });
      }

      setConfirmState(null);
      return;
    }

    const { team, status, shouldRefund } = confirmState;
    await executeTeamUpdate(team, status, shouldRefund);
    setConfirmState(null);
  }, [confirmState, executeTeamUpdate, updateGuestStatus]);

  const onRetryGuests = useCallback(() => {
    void loadGuests("load");
  }, [loadGuests]);

  const metrics = useMemo(() => {
    return {
      pending: filteredGuests.filter((guest) => guest.approvalStatus === "pending_approval")
        .length,
      approved: filteredGuests.filter((guest) => guest.approvalStatus === "approved").length,
      declined: filteredGuests.filter((guest) => guest.approvalStatus === "declined").length,
      total: filteredGuests.length,
    };
  }, [filteredGuests]);

  const drawerOpen = Boolean(selectedGuest || selectedTeam);

  return (
    <div className="min-h-screen">
      {/* Top accent line */}
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent-light)] to-transparent opacity-50" />

      <div className="mx-auto grid w-full max-w-[1520px] lg:grid-cols-[1fr_380px]">
        {/* ── Main content ── */}
        <main className="space-y-5 border-r border-[var(--border-subtle)] px-6 pt-7 pb-10">
          {/* Header */}
          <header className="space-y-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="font-display text-[11px] font-medium uppercase tracking-[0.25em] text-[var(--accent-light)]">
                  Luma Review
                </p>
                <h1 className="mt-1.5 font-display text-[1.65rem] font-semibold leading-tight tracking-tight">
                  Hackathon Review Console
                </h1>
                <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-[var(--text-muted)]">
                  Review pending applicants, compare team submissions, and manage approvals.
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text)] disabled:opacity-40"
                  onClick={() => void loadGuests("refresh")}
                  disabled={!selectedEvent || guestsRefreshing || guestsLoading}
                >
                  {guestsRefreshing ? "Refreshing\u2026" : "Refresh"}
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)]"
                  onClick={() => {
                    setBanner(null);
                    setSearchTerm("");
                    setRegistrationFilter("all");
                    setApprovalFilter("pending_approval");
                  }}
                >
                  Reset Filters
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_minmax(200px,1fr)_minmax(170px,1fr)_minmax(170px,1fr)]">
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Event
                </span>
                <select
                  className={selectClass}
                  value={selectedEventApiId ?? ""}
                  onChange={(event) => setSelectedEventApiId(event.target.value || null)}
                  disabled={eventsLoading || !visibleEvents.length}
                >
                  {!visibleEvents.length ? <option value="">No events available</option> : null}
                  {visibleEvents.map((event) => (
                    <option key={event.eventApiId} value={event.eventApiId}>
                      {event.name}
                      {event.startAt ? ` \u00b7 ${new Date(event.startAt).toLocaleDateString()}` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Status
                </span>
                <select
                  className={selectClass}
                  value={approvalFilter}
                  onChange={(event) =>
                    setApprovalFilter(event.target.value as GuestStatus | "all")
                  }
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Registration
                </span>
                <select
                  className={selectClass}
                  value={registrationFilter}
                  onChange={(event) =>
                    setRegistrationFilter(event.target.value as RegistrationFilter)
                  }
                >
                  <option value="all">All</option>
                  <option value="team">Team applicants</option>
                  <option value="solo">Solo applicants</option>
                </select>
              </label>

              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Search
                </span>
                <input
                  className={inputClass}
                  placeholder="Name, email, idea\u2026"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </label>
            </div>

            {/* Toggle options */}
            <div className="flex flex-wrap items-center gap-5 text-[13px] text-[var(--text-secondary)]">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={showAllEvents}
                  onChange={(event) => setShowAllEvents(event.target.checked)}
                />
                Show all events
              </label>

              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={includeSoloTeams}
                  onChange={(event) => setIncludeSoloTeams(event.target.checked)}
                />
                Solo attendees in Teams view
              </label>
            </div>

            {/* Active event indicator */}
            {selectedEvent ? (
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent-light)]" />
                <span>
                  <span className="font-medium text-[var(--text-secondary)]">
                    {selectedEvent.name}
                  </span>
                  {selectedEvent.startAt
                    ? ` \u00b7 ${new Date(selectedEvent.startAt).toLocaleString()}`
                    : ""}
                </span>
              </div>
            ) : null}
          </header>

          {/* Banner */}
          {banner ? <BannerNotice banner={banner} /> : null}

          {/* Metrics */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InlineMetric label="Pending" value={metrics.pending} />
            <InlineMetric label="Approved" value={metrics.approved} />
            <InlineMetric label="Declined" value={metrics.declined} />
            <InlineMetric label="Visible" value={metrics.total} />
          </div>

          {/* Errors */}
          {eventsError ? <ErrorPanel error={eventsError} onRetry={loadEvents} /> : null}
          {guestsError ? <ErrorPanel error={guestsError} onRetry={onRetryGuests} /> : null}

          {/* ── Data table section ── */}
          <section className="overflow-hidden rounded-xl border border-[var(--border)]">
            {/* Tab bar */}
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-raised)] px-1">
              <div className="flex">
                <button
                  type="button"
                  className={cn(
                    "relative px-4 py-3 text-sm font-medium transition-colors",
                    activeTab === "teams"
                      ? "text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                  )}
                  onClick={() => setActiveTab("teams")}
                >
                  Teams ({teams.length})
                  {activeTab === "teams" ? (
                    <span className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--accent)]" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className={cn(
                    "relative px-4 py-3 text-sm font-medium transition-colors",
                    activeTab === "people"
                      ? "text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                  )}
                  onClick={() => setActiveTab("people")}
                >
                  People ({filteredGuests.length})
                  {activeTab === "people" ? (
                    <span className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--accent)]" />
                  ) : null}
                </button>
              </div>

              {guestsLoading ? (
                <span className="pr-3 text-xs text-[var(--text-muted)]">Loading\u2026</span>
              ) : null}
            </div>

            {/* Teams table */}
            {activeTab === "teams" ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="px-4 py-3 font-medium">Team</th>
                      <th className="px-4 py-3 font-medium">Members</th>
                      <th className="px-4 py-3 font-medium">Pending</th>
                      <th className="px-4 py-3 font-medium">Approved</th>
                      <th className="px-4 py-3 font-medium">Declined</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!teams.length ? (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-sm text-[var(--text-muted)]"
                          colSpan={6}
                        >
                          No team groups match this filter.
                        </td>
                      </tr>
                    ) : null}

                    {teams.map((team) => (
                      <tr
                        key={team.key}
                        className="cursor-pointer border-t border-[var(--border-subtle)] transition-colors hover:bg-[var(--bg-hover)]"
                        onClick={() => {
                          setSelectedTeamKey(team.key);
                          setSelectedGuestApiId(null);
                        }}
                      >
                        <td className="px-4 py-3 align-top">
                          <div className="font-medium">{team.displayName}</div>
                          {team.hasNameVariantWarning ? (
                            <span className="mt-1 inline-flex rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                              Name variants: {team.rawNameVariants.join(" / ")}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 align-top tabular-nums text-[var(--text-secondary)]">
                          {team.members.length}
                        </td>
                        <td className="px-4 py-3 align-top tabular-nums text-[var(--text-secondary)]">
                          {team.counts.pending_approval}
                        </td>
                        <td className="px-4 py-3 align-top tabular-nums text-[var(--text-secondary)]">
                          {team.counts.approved}
                        </td>
                        <td className="px-4 py-3 align-top tabular-nums text-[var(--text-secondary)]">
                          {team.counts.declined}
                        </td>
                        <td className="px-4 py-3 align-top text-right">
                          <div
                            className="inline-flex gap-2"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)] disabled:opacity-40"
                              onClick={() => onTeamAction(team, "approved")}
                              disabled={pendingTeamKey === team.key}
                            >
                              {pendingTeamKey === team.key ? "Working\u2026" : "Approve team"}
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-40"
                              onClick={() => onTeamAction(team, "declined")}
                              disabled={pendingTeamKey === team.key}
                            >
                              Decline team
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              /* People table */
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Team</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Build Idea</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!filteredGuests.length ? (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-sm text-[var(--text-muted)]"
                          colSpan={5}
                        >
                          No guests match this filter.
                        </td>
                      </tr>
                    ) : null}

                    {filteredGuests.map((guest) => (
                      <tr
                        key={guest.apiId}
                        className="cursor-pointer border-t border-[var(--border-subtle)] transition-colors hover:bg-[var(--bg-hover)]"
                        onClick={() => {
                          setSelectedGuestApiId(guest.apiId);
                          setSelectedTeamKey(null);
                        }}
                      >
                        <td className="px-4 py-3 align-top">
                          <div className="font-medium">{guest.name}</div>
                          <div className="text-xs text-[var(--text-muted)]">{guest.email}</div>
                        </td>
                        <td className="px-4 py-3 align-top text-[var(--text-secondary)]">
                          {guest.teamNameRaw || "Solo"}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <span
                            className={cn(
                              "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                              statusBadge(guest.approvalStatus),
                            )}
                          >
                            {guest.approvalStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top text-xs text-[var(--text-muted)]">
                          {shortText(guest.normalizedAnswers.buildIdea, 110)}
                        </td>
                        <td className="px-4 py-3 align-top text-right">
                          <div
                            className="inline-flex gap-2"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)] disabled:opacity-40"
                              onClick={() => void onGuestApprove(guest)}
                              disabled={Boolean(pendingGuestIds[guest.apiId])}
                            >
                              {pendingGuestIds[guest.apiId] ? "Working\u2026" : "Approve"}
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-40"
                              onClick={() => onGuestDecline(guest)}
                              disabled={Boolean(pendingGuestIds[guest.apiId])}
                            >
                              Decline
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>

        {/* ── Detail drawer ── */}
        <aside className="lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto">
          <div className="p-5">
            {/* Empty state */}
            {!drawerOpen ? (
              <div className="flex h-[calc(100vh-80px)] flex-col items-center justify-center text-center">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    className="text-[var(--text-muted)]"
                  >
                    <rect x="2" y="2" width="14" height="14" rx="3" />
                    <path d="M6 7h6M6 11h4" />
                  </svg>
                </div>
                <p className="font-display text-sm font-medium text-[var(--text-secondary)]">
                  Detail Panel
                </p>
                <p className="mt-1.5 max-w-[24ch] text-xs leading-relaxed text-[var(--text-muted)]">
                  Select a team or attendee to view their full details.
                </p>
              </div>
            ) : null}

            {/* Guest detail */}
            {selectedGuest ? (
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--accent-light)]">
                      Attendee
                    </p>
                    <h2 className="mt-1 font-display text-xl font-semibold">
                      {selectedGuest.name}
                    </h2>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                      {selectedGuest.email}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text)]"
                    onClick={() => setSelectedGuestApiId(null)}
                    aria-label="Close"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M3 3l8 8M11 3l-8 8" />
                    </svg>
                  </button>
                </div>

                <div className="grid gap-4">
                  <DetailItem label="Status" value={selectedGuest.approvalStatus} />
                  <DetailItem label="Team" value={selectedGuest.teamNameRaw || "Solo"} />
                  <DetailItem
                    label="Registering as"
                    value={selectedGuest.normalizedAnswers.registrationAs}
                  />
                  <DetailItem
                    label="Affiliation"
                    value={selectedGuest.normalizedAnswers.affiliation}
                  />
                  <DetailItem
                    label="Codex usage"
                    value={selectedGuest.normalizedAnswers.codexUsage}
                  />
                  <DetailItem
                    label="In-person"
                    value={
                      selectedGuest.normalizedAnswers.inPersonConfirmed === null
                        ? null
                        : selectedGuest.normalizedAnswers.inPersonConfirmed
                          ? "Yes"
                          : "No"
                    }
                  />
                  <DetailItem
                    label="Build idea"
                    value={selectedGuest.normalizedAnswers.buildIdea}
                  />
                  <DetailItem
                    label="Additional notes"
                    value={selectedGuest.normalizedAnswers.additionalNotes}
                  />

                  {/* Profile links */}
                  <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                      Profile Links
                    </p>
                    <DetailItem label="LinkedIn" value={selectedGuest.normalizedAnswers.linkedin} />
                    <DetailItem label="GitHub" value={selectedGuest.normalizedAnswers.github} />
                    <DetailItem label="X" value={selectedGuest.normalizedAnswers.twitterX} />
                  </div>

                  {/* Raw answers */}
                  <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                      Raw Registration Answers
                    </p>
                    {Object.entries(selectedGuest.normalizedAnswers.rawAnswerMap).length ? (
                      <div className="space-y-2.5">
                        {Object.entries(selectedGuest.normalizedAnswers.rawAnswerMap).map(
                          ([label, value]) => (
                            <div key={label}>
                              <p className="text-xs font-medium text-[var(--text-secondary)]">
                                {label}
                              </p>
                              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{value}</p>
                            </div>
                          ),
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--text-muted)]">
                        No answers returned by API.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Team detail */}
            {selectedTeam ? (
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--accent-light)]">
                      Team
                    </p>
                    <h2 className="mt-1 font-display text-xl font-semibold">
                      {selectedTeam.displayName}
                    </h2>
                    {selectedTeam.hasNameVariantWarning ? (
                      <p className="mt-1 text-xs text-amber-400/80">
                        Name variants: {selectedTeam.rawNameVariants.join(" / ")}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text)]"
                    onClick={() => setSelectedTeamKey(null)}
                    aria-label="Close"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M3 3l8 8M11 3l-8 8" />
                    </svg>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <InlineMetric label="Members" value={selectedTeam.members.length} />
                  <InlineMetric label="Pending" value={selectedTeam.counts.pending_approval} />
                  <InlineMetric label="Approved" value={selectedTeam.counts.approved} />
                  <InlineMetric label="Declined" value={selectedTeam.counts.declined} />
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    Members
                  </p>
                  {selectedTeam.members.map((member) => (
                    <button
                      key={member.apiId}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[var(--accent)]/25 hover:bg-[var(--bg-hover)]"
                      onClick={() => {
                        setSelectedTeamKey(null);
                        setSelectedGuestApiId(member.apiId);
                      }}
                    >
                      <span>
                        <span className="font-medium">{member.name}</span>
                        <span className="block text-xs text-[var(--text-muted)]">
                          {member.email}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs font-medium",
                          statusBadge(member.approvalStatus),
                        )}
                      >
                        {member.approvalStatus}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {/* ── Confirm modal ── */}
      {confirmState ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--bg-raised)] p-6 shadow-[0_25px_50px_rgba(0,0,0,0.5)]">
            <h3 className="font-display text-lg font-semibold">
              {confirmState.status === "approved" ? "Approve" : "Decline"}{" "}
              {confirmState.scope === "guest" ? "attendee" : "team"}
            </h3>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              {confirmState.scope === "guest"
                ? `${confirmState.guest.name} will be set to ${confirmState.status}.`
                : `${confirmState.team.members.length} member(s) in ${confirmState.team.displayName} will be processed.`}
            </p>

            {confirmState.status === "declined" ? (
              <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={confirmState.shouldRefund}
                  onChange={(event) =>
                    setConfirmState((current) => {
                      if (!current) {
                        return current;
                      }

                      return {
                        ...current,
                        shouldRefund: event.target.checked,
                      };
                    })
                  }
                />
                Send refund if this guest has paid
              </label>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
                onClick={() => setConfirmState(null)}
                disabled={confirmState.submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40",
                  confirmState.status === "approved"
                    ? "bg-[var(--accent)] hover:bg-[var(--accent-light)]"
                    : "bg-red-600 hover:bg-red-500",
                )}
                onClick={() => void onConfirmAction()}
                disabled={confirmState.submitting}
              >
                {confirmState.submitting
                  ? "Applying\u2026"
                  : confirmState.status === "approved"
                    ? "Approve"
                    : "Decline"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
