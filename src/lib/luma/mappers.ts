import {
  GUEST_STATUSES,
  type GuestReviewRecord,
  type GuestStatus,
  type LumaGuestEntryRaw,
  type NormalizedRegistrationAnswers,
  type RegistrationAnswer,
} from "@/lib/luma/types";
import { normalizeTeamName } from "@/lib/teams/grouping";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function canonicalizeLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stringifyAnswerValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => stringifyAnswerValue(item))
      .filter((item): item is string => Boolean(item));

    if (!items.length) {
      return null;
    }

    return items.join(", ");
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const company = stringifyAnswerValue(record.company);
  const jobTitle = stringifyAnswerValue(record.job_title);

  if (company || jobTitle) {
    return [company, jobTitle].filter(Boolean).join(" / ");
  }

  const pairs = Object.entries(record)
    .map(([key, item]) => {
      const stringified = stringifyAnswerValue(item);
      if (!stringified) {
        return null;
      }
      return `${key}: ${stringified}`;
    })
    .filter((entry): entry is string => Boolean(entry));

  if (!pairs.length) {
    return null;
  }

  return pairs.join(" | ");
}

function extractAnswerText(answer: RegistrationAnswer): string | null {
  const directAnswer = stringifyAnswerValue(answer.answer);
  if (directAnswer) {
    return directAnswer;
  }

  const companyParts = [answer.answer_company, answer.answer_job_title]
    .map((value) => asString(value))
    .filter((value): value is string => Boolean(value));

  if (companyParts.length) {
    return companyParts.join(" / ");
  }

  return stringifyAnswerValue(answer.value);
}

function labelIncludesAll(label: string, pieces: string[]): boolean {
  return pieces.every((piece) => label.includes(piece));
}

function findAnswer(
  entries: Array<{ label: string; value: string }>,
  matcher: (label: string) => boolean,
): string | null {
  const match = entries.find((entry) => matcher(entry.label));
  return match?.value ?? null;
}

function stripHandleDecorators(value: string): string {
  return value.replace(/^@+/, "").replace(/^https?:\/\//i, "").trim();
}

function normalizeUrl(value: string, fallbackPrefix: string): string {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `${fallbackPrefix}${value}`;
}

export function normalizeLinkedIn(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cleaned = stripHandleDecorators(value).replace(/^www\./i, "");
  if (/linkedin\.com\//i.test(cleaned)) {
    return normalizeUrl(cleaned, "https://");
  }

  return `https://www.linkedin.com/in/${cleaned.replace(/^in\//i, "")}`;
}

export function normalizeGitHub(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cleaned = stripHandleDecorators(value).replace(/^www\./i, "");
  if (/github\.com\//i.test(cleaned)) {
    return normalizeUrl(cleaned, "https://");
  }

  return `https://github.com/${cleaned}`;
}

export function normalizeTwitterX(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cleaned = stripHandleDecorators(value).replace(/^www\./i, "");
  if (/(x|twitter)\.com\//i.test(cleaned)) {
    const converted = cleaned.replace(/twitter\.com\//i, "x.com/");
    return normalizeUrl(converted, "https://");
  }

  return `https://x.com/${cleaned}`;
}

function parseBooleanish(value: string | null): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (["yes", "true", "1", "agree", "confirmed"].some((token) => normalized.includes(token))) {
    return true;
  }

  if (["no", "false", "0", "decline"].some((token) => normalized.includes(token))) {
    return false;
  }

  return null;
}

export function normalizeRegistrationAnswers(
  answers: RegistrationAnswer[],
): NormalizedRegistrationAnswers {
  const parsedEntries: Array<{ rawLabel: string; label: string; value: string }> = [];
  const rawAnswerMap: Record<string, string> = {};

  for (const answer of answers) {
    const rawLabel = asString(answer.label);
    if (!rawLabel) {
      continue;
    }

    const value = extractAnswerText(answer);
    if (!value) {
      continue;
    }

    parsedEntries.push({
      rawLabel,
      label: canonicalizeLabel(rawLabel),
      value,
    });

    rawAnswerMap[rawLabel] = value;
  }

  const affiliation = findAnswer(parsedEntries, (label) =>
    labelIncludesAll(label, ["primary", "affiliation"]),
  );

  const linkedinRaw = findAnswer(parsedEntries, (label) => label.includes("linkedin"));
  const githubRaw = findAnswer(parsedEntries, (label) => label.includes("github"));
  const twitterRaw = findAnswer(
    parsedEntries,
    (label) => label.includes("twitter") || label.includes(" x "),
  );

  const buildIdea = findAnswer(parsedEntries, (label) =>
    labelIncludesAll(label, ["want", "build"]),
  );

  const registrationAs = findAnswer(parsedEntries, (label) =>
    labelIncludesAll(label, ["registering", "as"]),
  );

  const teamName = findAnswer(parsedEntries, (label) =>
    labelIncludesAll(label, ["team", "name"]),
  );

  const codexUsage = findAnswer(parsedEntries, (label) =>
    labelIncludesAll(label, ["used", "codex"]),
  );

  const additionalNotes = findAnswer(parsedEntries, (label) =>
    labelIncludesAll(label, ["anything", "else"]),
  );

  const inPersonRaw = findAnswer(parsedEntries, (label) => {
    return (
      labelIncludesAll(label, ["in", "person"]) ||
      labelIncludesAll(label, ["able", "attend"]) ||
      labelIncludesAll(label, ["singapore", "attend"])
    );
  });

  return {
    affiliation,
    linkedin: normalizeLinkedIn(linkedinRaw),
    github: normalizeGitHub(githubRaw),
    twitterX: normalizeTwitterX(twitterRaw),
    buildIdea,
    registrationAs,
    teamName,
    codexUsage,
    additionalNotes,
    inPersonConfirmed: parseBooleanish(inPersonRaw),
    rawAnswerMap,
  };
}

export function inferIsSoloRegistrant(
  normalizedAnswers: NormalizedRegistrationAnswers,
): boolean {
  const registrationAs = normalizedAnswers.registrationAs?.toLowerCase() ?? "";

  if (registrationAs.includes("solo")) {
    return true;
  }

  if (registrationAs.includes("team")) {
    return false;
  }

  return !normalizedAnswers.teamName;
}

function resolveApprovalStatus(input: string | null): GuestStatus {
  if (!input) {
    return "pending_approval";
  }

  if (GUEST_STATUSES.includes(input as GuestStatus)) {
    return input as GuestStatus;
  }

  return "pending_approval";
}

export function mapGuestEntryToReviewRecord(
  entry: LumaGuestEntryRaw,
  context: { eventId: string; eventApiId: string },
): GuestReviewRecord {
  const guest = asRecord(entry.guest) ?? {};
  const apiId = asString(entry.api_id) ?? asString(guest.id) ?? "";

  const firstName = asString(guest.user_first_name);
  const lastName = asString(guest.user_last_name);
  const fallbackName = [firstName, lastName].filter(Boolean).join(" ").trim();

  const tickets = asArray(guest.tickets).map((ticket) => asRecord(ticket));
  const primaryTicket = tickets.find((ticket) => ticket) ?? null;

  const registrationAnswers = asArray(guest.registration_answers)
    .map((answer) => asRecord(answer))
    .filter((answer): answer is RegistrationAnswer => Boolean(answer));

  const normalizedAnswers = normalizeRegistrationAnswers(registrationAnswers);
  const isSoloRegistrant = inferIsSoloRegistrant(normalizedAnswers);
  const teamNameRaw = normalizedAnswers.teamName;
  const fallbackIdentifier =
    apiId || asString(guest.user_email) || asString(guest.id) || "unknown";

  const teamKey = teamNameRaw
    ? normalizeTeamName(teamNameRaw)
    : isSoloRegistrant
      ? `solo:${fallbackIdentifier}`
      : `team-missing:${fallbackIdentifier}`;

  return {
    apiId,
    guestId: asString(guest.id) ?? apiId,
    eventId: context.eventId,
    eventApiId: context.eventApiId,
    name: asString(guest.user_name) ?? fallbackName ?? asString(guest.name) ?? "Unknown attendee",
    firstName,
    lastName,
    email: asString(guest.user_email) ?? asString(guest.email) ?? "",
    phoneNumber: asString(guest.phone_number),
    createdAt: asString(guest.created_at),
    registeredAt: asString(guest.registered_at),
    checkedInAt: asString(guest.checked_in_at),
    approvalStatus: resolveApprovalStatus(asString(guest.approval_status)),
    customSource: asString(guest.custom_source),
    qrCodeUrl: asString(guest.check_in_qr_code) ?? asString(guest.qr_code_url),
    amount: asNumber(primaryTicket?.amount ?? guest.amount),
    amountTax: asNumber(primaryTicket?.amount_tax ?? guest.amount_tax),
    amountDiscount: asNumber(primaryTicket?.amount_discount ?? guest.amount_discount),
    currency: asString(primaryTicket?.currency ?? guest.currency),
    couponCode: asString(primaryTicket?.coupon_code ?? guest.coupon_code),
    ethAddress: asString(guest.eth_address),
    solanaAddress: asString(guest.solana_address),
    surveyResponseRating: asNumber(guest.survey_response_rating),
    surveyResponseFeedback: asString(guest.survey_response_feedback),
    ticketTypeId: asString(primaryTicket?.ticket_type_id ?? guest.ticket_type_id),
    ticketName: asString(primaryTicket?.ticket_name ?? guest.ticket_name),
    registrationAnswers,
    normalizedAnswers,
    teamKey,
    teamNameRaw,
    isSoloRegistrant,
  };
}
