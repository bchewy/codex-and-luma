"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const PANEL_WIDTH_KEY = "luma-review:panel-width";
const DEFAULT_PANEL_WIDTH = 580;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_RATIO = 0.6;

const SPOTS_KEY = "luma-review:spots-remaining";
const COLUMNS_KEY = "luma-review:visible-columns";

type PeopleColumn = "team" | "status" | "buildIdea";
const ALL_PEOPLE_COLUMNS: { key: PeopleColumn; label: string }[] = [
  { key: "team", label: "Team" },
  { key: "status", label: "Status" },
  { key: "buildIdea", label: "Build Idea" },
];
const DEFAULT_VISIBLE: PeopleColumn[] = ["team", "status", "buildIdea"];

function readVisibleColumns(): PeopleColumn[] {
  if (typeof window === "undefined") return DEFAULT_VISIBLE;
  const stored = localStorage.getItem(COLUMNS_KEY);
  if (!stored) return DEFAULT_VISIBLE;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE;
}

function writeVisibleColumns(cols: PeopleColumn[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(COLUMNS_KEY, JSON.stringify(cols));
}

const DRAFT_STATUS_KEY = "luma-review:draft-status";
type DraftStatus = "accepted" | "rejected";
type DraftStatusMap = Map<string, DraftStatus>;
type DraftFilter = "all" | "accepted" | "rejected" | "undecided";

function readDraftStatus(): DraftStatusMap {
  if (typeof window === "undefined") return new Map();
  const stored = localStorage.getItem(DRAFT_STATUS_KEY);
  if (!stored) return new Map();
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      // Migrate from old draft-rejections format (array of IDs)
      return new Map(parsed.map((id: string) => [id, "rejected" as DraftStatus]));
    }
    if (parsed && typeof parsed === "object") {
      return new Map(Object.entries(parsed) as Array<[string, DraftStatus]>);
    }
  } catch { /* ignore */ }
  return new Map();
}

function writeDraftStatus(map: DraftStatusMap): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(DRAFT_STATUS_KEY, JSON.stringify(Object.fromEntries(map)));
}

const FILTERS_KEY = "luma-review:filters";

type PersistedFilters = {
  activeTab?: Tab;
  approvalFilter?: GuestStatus | "all";
  registrationFilter?: RegistrationFilter;
  searchTerm?: string;
  buildIdeaFilter?: string;
  buildIdeaPresence?: "all" | "filled" | "empty";
  draftFilter?: DraftFilter;
  includeSoloTeams?: boolean;
  selectedEventApiId?: string | null;
  showAllEvents?: boolean;
};

function readFilters(): PersistedFilters {
  if (typeof window === "undefined") return {};
  const stored = localStorage.getItem(FILTERS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch { /* ignore */ }
  return {};
}

function writeFilters(filters: PersistedFilters): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
}

function readSpots(): number | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(SPOTS_KEY);
  if (stored === null) return null;
  const num = Number(stored);
  return Number.isFinite(num) ? num : null;
}

function writeSpots(value: number | null): void {
  if (typeof window === "undefined") return;
  if (value === null) {
    localStorage.removeItem(SPOTS_KEY);
  } else {
    localStorage.setItem(SPOTS_KEY, String(value));
  }
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

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function downloadCsv(filename: string, headers: string[], rows: string[][]): void {
  const headerLine = headers.map(escapeCsvField).join(",");
  const bodyLines = rows.map((row) => row.map(escapeCsvField).join(","));
  const csv = [headerLine, ...bodyLines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  const isUrl = value && /^https?:\/\//i.test(value);
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      {isUrl ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block break-words text-sm text-[var(--accent-light)] underline decoration-[var(--accent-light)]/30 underline-offset-2 transition-colors hover:text-[var(--accent)] hover:decoration-[var(--accent)]/60"
        >
          {value.replace(/^https?:\/\/(www\.)?/i, "")}
        </a>
      ) : (
        <p className="mt-0.5 break-words text-sm text-[var(--text-secondary)]">
          {value || "\u2014"}
        </p>
      )}
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
  const [filtersHydrated, setFiltersHydrated] = useState(false);

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
  const [buildIdeaFilter, setBuildIdeaFilter] = useState("");
  const [buildIdeaPresence, setBuildIdeaPresence] = useState<"all" | "filled" | "empty">("all");
  const [draftFilter, setDraftFilter] = useState<DraftFilter>("all");
  const [includeSoloTeams, setIncludeSoloTeams] = useState(false);

  const [showScrollTop, setShowScrollTop] = useState(false);

  /* Hydrate filters from localStorage on mount */
  useEffect(() => {
    const saved = readFilters();
    if (saved.activeTab) setActiveTab(saved.activeTab);
    if (saved.approvalFilter) setApprovalFilter(saved.approvalFilter);
    if (saved.registrationFilter) setRegistrationFilter(saved.registrationFilter);
    if (saved.searchTerm) setSearchTerm(saved.searchTerm);
    if (saved.buildIdeaFilter) setBuildIdeaFilter(saved.buildIdeaFilter);
    if (saved.buildIdeaPresence) setBuildIdeaPresence(saved.buildIdeaPresence);
    if (saved.draftFilter) setDraftFilter(saved.draftFilter);
    if (saved.includeSoloTeams !== undefined) setIncludeSoloTeams(saved.includeSoloTeams);
    if (saved.selectedEventApiId !== undefined) setSelectedEventApiId(saved.selectedEventApiId);
    if (saved.showAllEvents !== undefined) setShowAllEvents(saved.showAllEvents);
    setFiltersHydrated(true);
  }, []);

  /* Persist filters to localStorage on change */
  useEffect(() => {
    if (!filtersHydrated) return;
    writeFilters({
      activeTab,
      approvalFilter,
      registrationFilter,
      searchTerm,
      buildIdeaFilter,
      buildIdeaPresence,
      draftFilter,
      includeSoloTeams,
      selectedEventApiId,
      showAllEvents,
    });
  }, [filtersHydrated, activeTab, approvalFilter, registrationFilter, searchTerm, buildIdeaFilter, buildIdeaPresence, draftFilter, includeSoloTeams, selectedEventApiId, showAllEvents]);

  /* Scroll-to-top visibility */
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const [selectedGuestApiId, setSelectedGuestApiId] = useState<string | null>(null);
  const [selectedTeamKey, setSelectedTeamKey] = useState<string | null>(null);
  const [drawerExpanded, setDrawerExpanded] = useState(false);

  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const gridRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem(PANEL_WIDTH_KEY);
    if (stored) {
      const num = Number(stored);
      if (Number.isFinite(num) && num >= MIN_PANEL_WIDTH) {
        setPanelWidth(num);
      }
    }
  }, []);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current || !gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const newWidth = rect.right - ev.clientX;
      const maxWidth = rect.width * MAX_PANEL_RATIO;
      const clamped = Math.max(MIN_PANEL_WIDTH, Math.min(newWidth, maxWidth));
      setPanelWidth(clamped);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      setPanelWidth((current) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(current)));
        return current;
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const [confirmState, setConfirmState] = useState<ConfirmState>(null);

  const [pendingGuestIds, setPendingGuestIds] = useState<Record<string, boolean>>({});
  const [pendingTeamKey, setPendingTeamKey] = useState<string | null>(null);

  const [banner, setBanner] = useState<Banner | null>(null);

  const [spotsRemaining, setSpotsRemaining] = useState<number | null>(null);
  const [editingSpots, setEditingSpots] = useState(false);
  const [spotsInput, setSpotsInput] = useState("");

  const [visibleColumns, setVisibleColumns] = useState<PeopleColumn[]>(DEFAULT_VISIBLE);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);

  const [draftStatuses, setDraftStatuses] = useState<DraftStatusMap>(new Map());

  useEffect(() => {
    setVisibleColumns(readVisibleColumns());
    setDraftStatuses(readDraftStatus());
  }, []);

  useEffect(() => {
    setSpotsRemaining(readSpots());
  }, []);

  const setDraft = useCallback((guestApiId: string, status: DraftStatus) => {
    setDraftStatuses((prev) => {
      const next = new Map(prev);
      if (next.get(guestApiId) === status) {
        next.delete(guestApiId);
      } else {
        next.set(guestApiId, status);
      }
      writeDraftStatus(next);
      return next;
    });
  }, []);

  const toggleColumn = useCallback((col: PeopleColumn) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col];
      writeVisibleColumns(next);
      return next;
    });
  }, []);

  const onHeaderContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setColumnMenu({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    if (!columnMenu) return;
    const close = () => setColumnMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [columnMenu]);

  const colVisible = useCallback(
    (col: PeopleColumn) => visibleColumns.includes(col),
    [visibleColumns],
  );

  const decrementSpots = useCallback((count: number = 1) => {
    setSpotsRemaining((current) => {
      if (current === null) return null;
      const next = Math.max(0, current - count);
      writeSpots(next);
      return next;
    });
  }, []);

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
    const ideaQuery = buildIdeaFilter.trim().toLowerCase();
    return guests.filter((guest) => {
      if (!matchesSearch(guest, searchTerm)) return false;
      if (!matchesRegistrationFilter(guest, registrationFilter)) return false;
      if (buildIdeaPresence === "filled" && !guest.normalizedAnswers.buildIdea) return false;
      if (buildIdeaPresence === "empty" && guest.normalizedAnswers.buildIdea) return false;
      if (draftFilter !== "all") {
        const status = draftStatuses.get(guest.apiId);
        if (draftFilter === "accepted" && status !== "accepted") return false;
        if (draftFilter === "rejected" && status !== "rejected") return false;
        if (draftFilter === "undecided" && status !== undefined) return false;
      }
      if (ideaQuery) {
        const idea = (guest.normalizedAnswers.buildIdea ?? "").toLowerCase();
        if (!idea.includes(ideaQuery)) return false;
      }
      return true;
    });
  }, [buildIdeaFilter, buildIdeaPresence, draftFilter, draftStatuses, guests, registrationFilter, searchTerm]);

  const teams = useMemo(() => {
    return buildTeamAggregates(filteredGuests, {
      includeSolo: includeSoloTeams,
    });
  }, [filteredGuests, includeSoloTeams]);

  const exportCsv = useCallback(() => {
    if (activeTab === "teams") {
      const headers = ["Team", "Members", "Pending", "Approved", "Declined"];
      const rows = teams.map((team) => [
        team.displayName,
        String(team.members.length),
        String(team.counts.pending_approval),
        String(team.counts.approved),
        String(team.counts.declined),
      ]);
      downloadCsv("teams-export.csv", headers, rows);
    } else {
      const headers: string[] = ["Name", "Email"];
      if (visibleColumns.includes("team")) headers.push("Team");
      if (visibleColumns.includes("status")) headers.push("Status");
      if (visibleColumns.includes("buildIdea")) headers.push("Build Idea");

      const exportable = filteredGuests.filter((guest) => draftStatuses.get(guest.apiId) !== "rejected");
      const rows = exportable.map((guest) => {
        const row: string[] = [guest.name, guest.email];
        if (visibleColumns.includes("team")) row.push(guest.teamNameRaw || "Solo");
        if (visibleColumns.includes("status")) row.push(guest.approvalStatus);
        if (visibleColumns.includes("buildIdea")) row.push(guest.normalizedAnswers.buildIdea ?? "");
        return row;
      });
      downloadCsv("people-export.csv", headers, rows);
    }
  }, [activeTab, draftStatuses, filteredGuests, teams, visibleColumns]);

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
    setDrawerExpanded(false);
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

      if (guest.approvalStatus !== "approved") {
        decrementSpots(1);
      }
      setBanner({
        kind: "success",
        message: `Approved ${guest.name}.`,
      });
    },
    [decrementSpots, updateGuestStatus],
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

        const successCount = candidates.length - failures.length;

        if (status === "approved" && successCount > 0) {
          decrementSpots(successCount);
        }

        if (!failures.length) {
          setBanner({
            kind: "success",
            message: `${status === "approved" ? "Approved" : "Declined"} ${candidates.length} attendee${candidates.length === 1 ? "" : "s"} in ${team.displayName}.`,
          });
          return;
        }

        setBanner({
          kind: "error",
          message: `Updated ${successCount}/${candidates.length} attendees in ${team.displayName}. ${failures.length} failed. First error: ${failures[0].message}`,
        });
      } finally {
        setPendingTeamKey(null);
      }
    },
    [decrementSpots, loadGuests, updateGuestStatus],
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
        if (status === "approved" && guest.approvalStatus !== "approved") {
          decrementSpots(1);
        }
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
  }, [confirmState, decrementSpots, executeTeamUpdate, updateGuestStatus]);

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
    <div className="min-h-screen overflow-x-clip">
      {/* Top accent line */}
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent-light)] to-transparent opacity-50" />

      <div
        ref={gridRef}
        className={cn(
          "mx-auto grid w-full grid-cols-1",
          !drawerExpanded && "lg:[grid-template-columns:minmax(0,1fr)_1px_var(--panel-width)]",
          drawerExpanded && "max-w-[960px]",
        )}
        style={drawerExpanded ? undefined : ({ "--panel-width": `${Math.round(panelWidth)}px` } as React.CSSProperties)}
      >
        {/* ── Main content ── */}
        <main
          className={cn(
            "min-w-0 space-y-5 overflow-hidden px-6 pt-7 pb-10",
            drawerExpanded && "hidden",
          )}
        >
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
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
                  onClick={exportCsv}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)]"
                  onClick={() => {
                    setBanner(null);
                    setSearchTerm("");
                    setBuildIdeaFilter("");
                    setBuildIdeaPresence("all");
                    setDraftFilter("all");
                    setRegistrationFilter("all");
                    setApprovalFilter("pending_approval");
                  }}
                >
                  Reset Filters
                </button>
              </div>
            </div>

            {/* Filters — row 1: dropdowns */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1.4fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)]">
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
                  Draft
                </span>
                <select
                  className={selectClass}
                  value={draftFilter}
                  onChange={(event) =>
                    setDraftFilter(event.target.value as DraftFilter)
                  }
                >
                  <option value="all">All</option>
                  <option value="accepted">Draft Accepted</option>
                  <option value="rejected">Draft Rejected</option>
                  <option value="undecided">Undecided</option>
                </select>
              </label>
            </div>

            {/* Filters — row 2: text inputs */}
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_minmax(120px,0.6fr)]">
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Search
                </span>
                <input
                  className={inputClass}
                  placeholder="Name, email\u2026"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Build Idea
                </span>
                <input
                  className={inputClass}
                  placeholder="Filter by build idea\u2026"
                  value={buildIdeaFilter}
                  onChange={(event) => setBuildIdeaFilter(event.target.value)}
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Has Idea
                </span>
                <select
                  className={selectClass}
                  value={buildIdeaPresence}
                  onChange={(event) => setBuildIdeaPresence(event.target.value as "all" | "filled" | "empty")}
                >
                  <option value="all">All</option>
                  <option value="filled">Has idea</option>
                  <option value="empty">No idea</option>
                </select>
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

          {/* Approval budget */}
          <div
            className={cn(
              "flex items-center justify-between rounded-lg border px-4 py-3",
              spotsRemaining === null
                ? "border-dashed border-[var(--border)]"
                : spotsRemaining > 0
                  ? "border-[var(--accent)]/20 bg-[var(--accent-glow)]"
                  : "border-red-500/20 bg-red-500/[0.06]",
            )}
          >
            {editingSpots ? (
              <form
                className="flex w-full items-center gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const num = Number(spotsInput);
                  if (Number.isFinite(num) && num >= 0) {
                    setSpotsRemaining(Math.round(num));
                    writeSpots(Math.round(num));
                  }
                  setEditingSpots(false);
                }}
              >
                <input
                  autoFocus
                  type="number"
                  min="0"
                  className="w-24 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm tabular-nums text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  value={spotsInput}
                  onChange={(e) => setSpotsInput(e.target.value)}
                />
                <button
                  type="submit"
                  className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)]"
                >
                  Save
                </button>
                <button
                  type="button"
                  className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
                  onClick={() => setEditingSpots(false)}
                >
                  Cancel
                </button>
              </form>
            ) : spotsRemaining === null ? (
              <div className="flex w-full items-center justify-between">
                <span className="text-sm text-[var(--text-muted)]">
                  No approval capacity set
                </span>
                <button
                  type="button"
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
                  onClick={() => {
                    setSpotsInput("");
                    setEditingSpots(true);
                  }}
                >
                  Set capacity
                </button>
              </div>
            ) : (
              <div className="flex w-full items-center justify-between">
                <div className="flex items-baseline gap-2.5">
                  <span
                    className={cn(
                      "font-display text-2xl font-bold tabular-nums",
                      spotsRemaining > 0
                        ? "text-[var(--accent-light)]"
                        : "text-red-400",
                    )}
                  >
                    {spotsRemaining}
                  </span>
                  <span className="text-sm text-[var(--text-secondary)]">
                    {spotsRemaining === 1 ? "spot remaining" : "spots remaining"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
                    onClick={() => {
                      setSpotsInput(String(spotsRemaining));
                      setEditingSpots(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-xs text-[var(--text-muted)] transition-colors hover:text-red-400"
                    onClick={() => {
                      setSpotsRemaining(null);
                      writeSpots(null);
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>

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
          <section className="relative overflow-hidden rounded-xl border border-[var(--border)]">
            {/* Progress bar — visible during any loading */}
            {(eventsLoading || guestsLoading || guestsRefreshing) ? (
              <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-[var(--accent)]/10">
                <div
                  className="h-full w-1/4 rounded-full bg-[var(--accent)]"
                  style={{ animation: "progress-slide 1.4s ease-in-out infinite" }}
                />
              </div>
            ) : null}

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

              {(eventsLoading || guestsLoading) ? (
                <span className="pr-3 text-xs text-[var(--text-muted)]">Loading\u2026</span>
              ) : guestsRefreshing ? (
                <span className="pr-3 text-xs text-[var(--text-muted)]">Refreshing\u2026</span>
              ) : null}
            </div>

            {/* Loading state — replaces table body during full loads */}
            {eventsLoading || guestsLoading ? (
              <div className="flex flex-col items-center justify-center py-20">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
                <p className="mt-3 text-sm text-[var(--text-muted)]">
                  {eventsLoading ? "Loading events\u2026" : "Loading guests\u2026"}
                </p>
              </div>
            ) : activeTab === "teams" ? (
              /* Teams table */
              <div
                className={cn(
                  "overflow-x-auto transition-opacity duration-200",
                  guestsRefreshing && "pointer-events-none opacity-40",
                )}
              >
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
              <div
                className={cn(
                  "relative overflow-x-auto transition-opacity duration-200",
                  guestsRefreshing && "pointer-events-none opacity-40",
                )}
              >
                {/* Column visibility context menu */}
                {columnMenu ? (
                  <div
                    className="fixed z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] py-1.5 shadow-xl shadow-black/40"
                    style={{ left: columnMenu.x, top: columnMenu.y }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                      Toggle columns
                    </p>
                    {ALL_PEOPLE_COLUMNS.map((col) => (
                      <button
                        key={col.key}
                        type="button"
                        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                        onClick={() => toggleColumn(col.key)}
                      >
                        <span
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                            colVisible(col.key)
                              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                              : "border-[var(--border)] bg-transparent text-transparent",
                          )}
                        >
                          {"\u2713"}
                        </span>
                        {col.label}
                      </button>
                    ))}
                  </div>
                ) : null}

                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr
                      className="border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]"
                      onContextMenu={onHeaderContextMenu}
                    >
                      <th className="px-4 py-3 font-medium">Name</th>
                      {colVisible("team") ? <th className="px-4 py-3 font-medium">Team</th> : null}
                      {colVisible("status") ? <th className="px-4 py-3 font-medium">Status</th> : null}
                      {colVisible("buildIdea") ? <th className="min-w-[280px] px-4 py-3 font-medium">Build Idea</th> : null}
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!filteredGuests.length ? (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-sm text-[var(--text-muted)]"
                          colSpan={2 + visibleColumns.length}
                        >
                          No guests match this filter.
                        </td>
                      </tr>
                    ) : null}

                    {filteredGuests.map((guest) => {
                      const guestDraft = draftStatuses.get(guest.apiId);
                      const isDraftRejected = guestDraft === "rejected";
                      const isDraftAccepted = guestDraft === "accepted";
                      return (
                        <tr
                          key={guest.apiId}
                          className={cn(
                            "cursor-pointer border-t border-[var(--border-subtle)] transition-colors hover:bg-[var(--bg-hover)]",
                            isDraftRejected && "opacity-45",
                            isDraftAccepted && "border-l-2 border-l-[var(--accent)]",
                          )}
                          onClick={() => {
                            setSelectedGuestApiId(guest.apiId);
                            setSelectedTeamKey(null);
                            setDrawerExpanded(false);
                          }}
                        >
                          <td className="px-4 py-3 align-top">
                            <div className={cn("font-medium", isDraftRejected && "line-through decoration-red-500/60", isDraftAccepted && "text-[var(--accent-light)]")}>
                              {guest.name}
                            </div>
                            <div className="text-xs text-[var(--text-muted)]">{guest.email}</div>
                          </td>
                          {colVisible("team") ? (
                            <td className={cn("px-4 py-3 align-top text-[var(--text-secondary)]", isDraftRejected && "line-through decoration-red-500/60")}>
                              {guest.teamNameRaw || "Solo"}
                            </td>
                          ) : null}
                          {colVisible("status") ? (
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
                          ) : null}
                          {colVisible("buildIdea") ? (
                            <td className={cn("min-w-[280px] max-w-[420px] px-4 py-3 align-top text-sm leading-relaxed text-[var(--text-secondary)]", isDraftRejected && "line-through decoration-red-500/60")}>
                              {guest.normalizedAnswers.buildIdea || <span className="text-[var(--text-muted)]">{"\u2014"}</span>}
                            </td>
                          ) : null}
                          <td className="px-4 py-3 align-top text-right">
                            <div
                              className="inline-flex gap-2"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className={cn(
                                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                                  isDraftAccepted
                                    ? "border border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent-light)] hover:bg-[var(--accent)]/20"
                                    : "border border-emerald-500/30 text-emerald-400/70 hover:border-emerald-500/50 hover:text-emerald-400",
                                )}
                                onClick={() => setDraft(guest.apiId, "accepted")}
                                title={isDraftAccepted ? "Undo draft accept" : "Draft accept (local only)"}
                              >
                                {isDraftAccepted ? "Undo \u2713" : "Draft \u2713"}
                              </button>
                              <button
                                type="button"
                                className={cn(
                                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                                  isDraftRejected
                                    ? "border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                                    : "border border-red-500/30 text-red-400/70 hover:border-red-500/50 hover:text-red-400",
                                )}
                                onClick={() => setDraft(guest.apiId, "rejected")}
                                title={isDraftRejected ? "Undo draft rejection" : "Draft reject (local only)"}
                              >
                                {isDraftRejected ? "Undo \u2715" : "Draft \u2715"}
                              </button>
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>

        {/* ── Resize handle ── */}
        {!drawerExpanded ? (
          <div
            className="group relative hidden cursor-col-resize bg-[var(--border-subtle)] lg:block"
            onMouseDown={onResizeStart}
          >
            {/* Wider invisible hit area */}
            <div className="absolute inset-y-0 -left-[5px] -right-[5px] z-20" />
            {/* Visual grip indicator */}
            <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[3px] opacity-0 transition-opacity group-hover:opacity-100">
              <span className="block h-[3px] w-[3px] rounded-full bg-[var(--text-muted)]" />
              <span className="block h-[3px] w-[3px] rounded-full bg-[var(--text-muted)]" />
              <span className="block h-[3px] w-[3px] rounded-full bg-[var(--text-muted)]" />
            </div>
          </div>
        ) : null}

        {/* ── Detail drawer ── */}
        <aside
          className={cn(
            drawerExpanded
              ? "px-6 pt-7 pb-10"
              : "lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto",
          )}
        >
          <div className={drawerExpanded ? "" : "p-5"}>
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
                {/* Back to table bar (expanded mode) */}
                {drawerExpanded ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
                    onClick={() => setDrawerExpanded(false)}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M10 3L5 8l5 5" />
                    </svg>
                    Back to table
                  </button>
                ) : null}

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
                  <div className="flex shrink-0 items-center gap-1.5">
                    {/* Expand / collapse toggle */}
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent-light)]"
                      onClick={() => setDrawerExpanded((v) => !v)}
                      aria-label={drawerExpanded ? "Collapse panel" : "Expand panel"}
                    >
                      {drawerExpanded ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M9 1v4h4M5 13V9H1M9 5L13 1M5 9l-4 4" />
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M13 5V1h-4M1 9v4h4M13 1L9 5M1 13l4-4" />
                        </svg>
                      )}
                    </button>
                    {/* Close */}
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text)]"
                      onClick={() => {
                        setSelectedTeamKey(null);
                        setDrawerExpanded(false);
                      }}
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
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <InlineMetric label="Members" value={selectedTeam.members.length} />
                  <InlineMetric label="Pending" value={selectedTeam.counts.pending_approval} />
                  <InlineMetric label="Approved" value={selectedTeam.counts.approved} />
                  <InlineMetric label="Declined" value={selectedTeam.counts.declined} />
                </div>

                <div className="space-y-3">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    Members
                  </p>
                  {selectedTeam.members.map((member) => {
                    const memberDraft = draftStatuses.get(member.apiId);
                    const memberDraftRejected = memberDraft === "rejected";
                    const memberDraftAccepted = memberDraft === "accepted";
                    return (
                    <div
                      key={member.apiId}
                      className={cn(
                        "rounded-lg border bg-[var(--bg-elevated)]",
                        memberDraftRejected && "border-[var(--border)] opacity-45",
                        memberDraftAccepted && "border-[var(--accent)]/40",
                        !memberDraft && "border-[var(--border)]",
                      )}
                    >
                      {/* Member header */}
                      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2.5">
                        <div>
                          <p className={cn("text-sm font-medium", memberDraftRejected && "line-through decoration-red-500/60", memberDraftAccepted && "text-[var(--accent-light)]")}>
                            {member.name}
                          </p>
                          <p className="text-xs text-[var(--text-muted)]">{member.email}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className={cn(
                              "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                              memberDraftAccepted
                                ? "border border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent-light)]"
                                : "border border-emerald-500/30 text-emerald-400/70 hover:text-emerald-400",
                            )}
                            onClick={() => setDraft(member.apiId, "accepted")}
                            title={memberDraftAccepted ? "Undo draft accept" : "Draft accept (local only)"}
                          >
                            {memberDraftAccepted ? "Undo \u2713" : "Draft \u2713"}
                          </button>
                          <button
                            type="button"
                            className={cn(
                              "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                              memberDraftRejected
                                ? "border border-red-500/40 bg-red-500/10 text-red-400"
                                : "border border-red-500/30 text-red-400/70 hover:text-red-400",
                            )}
                            onClick={() => setDraft(member.apiId, "rejected")}
                            title={memberDraftRejected ? "Undo draft rejection" : "Draft reject (local only)"}
                          >
                            {memberDraftRejected ? "Undo \u2715" : "Draft \u2715"}
                          </button>
                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-xs font-medium",
                              statusBadge(member.approvalStatus),
                            )}
                          >
                            {member.approvalStatus}
                          </span>
                        </div>
                      </div>

                      {/* Member details */}
                      <div className="grid gap-3 px-3 py-3">
                        <DetailItem
                          label="Affiliation"
                          value={member.normalizedAnswers.affiliation}
                        />
                        <DetailItem
                          label="Registering as"
                          value={member.normalizedAnswers.registrationAs}
                        />
                        <DetailItem
                          label="Codex usage"
                          value={member.normalizedAnswers.codexUsage}
                        />
                        <DetailItem
                          label="In-person"
                          value={
                            member.normalizedAnswers.inPersonConfirmed === null
                              ? null
                              : member.normalizedAnswers.inPersonConfirmed
                                ? "Yes"
                                : "No"
                          }
                        />
                        <DetailItem
                          label="Build idea"
                          value={member.normalizedAnswers.buildIdea}
                        />
                        <DetailItem
                          label="Additional notes"
                          value={member.normalizedAnswers.additionalNotes}
                        />

                        {/* Profile links */}
                        {(member.normalizedAnswers.linkedin ||
                          member.normalizedAnswers.github ||
                          member.normalizedAnswers.twitterX) ? (
                          <div className="space-y-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                              Links
                            </p>
                            {member.normalizedAnswers.linkedin ? (
                              <DetailItem label="LinkedIn" value={member.normalizedAnswers.linkedin} />
                            ) : null}
                            {member.normalizedAnswers.github ? (
                              <DetailItem label="GitHub" value={member.normalizedAnswers.github} />
                            ) : null}
                            {member.normalizedAnswers.twitterX ? (
                              <DetailItem label="X" value={member.normalizedAnswers.twitterX} />
                            ) : null}
                          </div>
                        ) : null}

                        {/* Raw answers */}
                        {Object.entries(member.normalizedAnswers.rawAnswerMap).length ? (
                          <div className="space-y-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                              Raw Answers
                            </p>
                            {Object.entries(member.normalizedAnswers.rawAnswerMap).map(
                              ([label, value]) => (
                                <div key={label}>
                                  <p className="text-xs font-medium text-[var(--text-secondary)]">
                                    {label}
                                  </p>
                                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                                    {value}
                                  </p>
                                </div>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    );
                  })}
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

      {/* Scroll to top */}
      {showScrollTop ? (
        <button
          type="button"
          className="fixed right-6 bottom-6 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] shadow-lg shadow-black/30 transition-all hover:border-[var(--accent)]/40 hover:text-[var(--accent-light)]"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll to top"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 13V3M3 7l5-5 5 5" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
