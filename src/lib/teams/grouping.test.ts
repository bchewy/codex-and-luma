import { buildTeamAggregates, normalizeTeamName } from "@/lib/teams/grouping";
import type { GuestReviewRecord } from "@/lib/luma/types";

function makeGuest(overrides: Partial<GuestReviewRecord>): GuestReviewRecord {
  const base: GuestReviewRecord = {
    apiId: "gst-1",
    guestId: "gst-1",
    eventId: "evt-1",
    eventApiId: "evt-api-1",
    name: "Alice",
    firstName: "Alice",
    lastName: "Example",
    email: "alice@example.com",
    phoneNumber: null,
    createdAt: null,
    registeredAt: null,
    checkedInAt: null,
    approvalStatus: "pending_approval",
    customSource: null,
    qrCodeUrl: null,
    amount: null,
    amountTax: null,
    amountDiscount: null,
    currency: null,
    couponCode: null,
    ethAddress: null,
    solanaAddress: null,
    surveyResponseRating: null,
    surveyResponseFeedback: null,
    ticketTypeId: null,
    ticketName: null,
    registrationAnswers: [],
    normalizedAnswers: {
      affiliation: null,
      linkedin: null,
      github: null,
      twitterX: null,
      buildIdea: null,
      registrationAs: null,
      teamName: null,
      codexUsage: null,
      additionalNotes: null,
      inPersonConfirmed: null,
      rawAnswerMap: {},
    },
    teamKey: "example-team",
    teamNameRaw: "Example Team",
    isSoloRegistrant: false,
  };

  return {
    ...base,
    ...overrides,
    normalizedAnswers: {
      ...base.normalizedAnswers,
      ...overrides.normalizedAnswers,
    },
  };
}

describe("normalizeTeamName", () => {
  it("trims, collapses spaces, and lowercases", () => {
    expect(normalizeTeamName("  Team   Alpha  ")).toBe("team alpha");
  });
});

describe("buildTeamAggregates", () => {
  it("groups normalized team names and flags variant warning", () => {
    const records = [
      makeGuest({ apiId: "gst-a", name: "A", teamNameRaw: "Team Rocket", teamKey: "team rocket" }),
      makeGuest({
        apiId: "gst-b",
        name: "B",
        teamNameRaw: "team  rocket",
        teamKey: "team rocket",
        approvalStatus: "approved",
      }),
      makeGuest({
        apiId: "gst-c",
        name: "C",
        teamNameRaw: "Team Rocket",
        teamKey: "team rocket",
        approvalStatus: "declined",
      }),
    ];

    const teams = buildTeamAggregates(records);

    expect(teams).toHaveLength(1);
    expect(teams[0].members).toHaveLength(3);
    expect(teams[0].hasNameVariantWarning).toBe(true);
    expect(teams[0].counts.pending_approval).toBe(1);
    expect(teams[0].counts.approved).toBe(1);
    expect(teams[0].counts.declined).toBe(1);
  });

  it("hides solo pseudo-teams by default and can include them", () => {
    const records = [
      makeGuest({ apiId: "gst-a", teamKey: "team-a", teamNameRaw: "Team A", isSoloRegistrant: false }),
      makeGuest({ apiId: "gst-solo", teamKey: "solo:gst-solo", teamNameRaw: null, isSoloRegistrant: true }),
    ];

    expect(buildTeamAggregates(records)).toHaveLength(1);
    expect(buildTeamAggregates(records, { includeSolo: true })).toHaveLength(2);
  });
});
