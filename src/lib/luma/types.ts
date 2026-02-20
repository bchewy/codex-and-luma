export type GuestStatus =
  | "approved"
  | "session"
  | "pending_approval"
  | "invited"
  | "declined"
  | "waitlist";

export type ReviewStatus = GuestStatus | "all";

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiError = {
  ok: false;
  error: {
    message: string;
    status?: number;
    code?: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface LumaEventSummary {
  eventId: string;
  eventApiId: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string | null;
  isHackathonLike: boolean;
}

export interface RegistrationAnswer {
  label?: string | null;
  question_id?: string;
  question_type?: string;
  value?: unknown;
  answer?: unknown;
  answer_company?: string | null;
  answer_job_title?: string | null;
  [key: string]: unknown;
}

export interface NormalizedRegistrationAnswers {
  affiliation: string | null;
  linkedin: string | null;
  github: string | null;
  twitterX: string | null;
  buildIdea: string | null;
  registrationAs: string | null;
  teamName: string | null;
  codexUsage: string | null;
  additionalNotes: string | null;
  inPersonConfirmed: boolean | null;
  rawAnswerMap: Record<string, string>;
}

export interface GuestReviewRecord {
  apiId: string;
  guestId: string;
  eventId: string;
  eventApiId: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phoneNumber: string | null;
  createdAt: string | null;
  registeredAt: string | null;
  checkedInAt: string | null;
  approvalStatus: GuestStatus;
  customSource: string | null;
  qrCodeUrl: string | null;
  amount: number | null;
  amountTax: number | null;
  amountDiscount: number | null;
  currency: string | null;
  couponCode: string | null;
  ethAddress: string | null;
  solanaAddress: string | null;
  surveyResponseRating: number | null;
  surveyResponseFeedback: string | null;
  ticketTypeId: string | null;
  ticketName: string | null;
  registrationAnswers: RegistrationAnswer[];
  normalizedAnswers: NormalizedRegistrationAnswers;
  teamKey: string;
  teamNameRaw: string | null;
  isSoloRegistrant: boolean;
}

export interface StatusCounts {
  approved: number;
  session: number;
  pending_approval: number;
  invited: number;
  declined: number;
  waitlist: number;
  total: number;
}

export interface TeamAggregate {
  key: string;
  normalizedTeamName: string | null;
  displayName: string;
  rawNameVariants: string[];
  members: GuestReviewRecord[];
  isSolo: boolean;
  hasNameVariantWarning: boolean;
  counts: StatusCounts;
}

export interface LumaEventEntryRaw {
  api_id?: string;
  event?: Record<string, unknown>;
}

export interface LumaGuestEntryRaw {
  api_id?: string;
  guest?: Record<string, unknown>;
}

export interface LumaPaginatedResponse<T> {
  entries: T[];
  next_cursor?: string | null;
}

export interface LumaEventsPayload {
  events: LumaEventSummary[];
}

export interface LumaGuestsPayload {
  eventApiId: string;
  eventId: string;
  guests: GuestReviewRecord[];
  countsByStatus: StatusCounts;
}

export interface GuestStatusUpdatePayload {
  guestApiId: string;
  eventApiId: string;
  status: "approved" | "declined";
}

export const GUEST_STATUSES: GuestStatus[] = [
  "pending_approval",
  "approved",
  "declined",
  "invited",
  "waitlist",
  "session",
];

export function createEmptyStatusCounts(): StatusCounts {
  return {
    approved: 0,
    session: 0,
    pending_approval: 0,
    invited: 0,
    declined: 0,
    waitlist: 0,
    total: 0,
  };
}
