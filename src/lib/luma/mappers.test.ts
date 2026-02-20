import {
  inferIsSoloRegistrant,
  mapGuestEntryToReviewRecord,
  normalizeGitHub,
  normalizeLinkedIn,
  normalizeRegistrationAnswers,
  normalizeTwitterX,
} from "@/lib/luma/mappers";
import type { RegistrationAnswer } from "@/lib/luma/types";

describe("link normalization", () => {
  it("normalizes github, linkedin, and x handles", () => {
    expect(normalizeGitHub("@octocat")).toBe("https://github.com/octocat");
    expect(normalizeLinkedIn("my-profile")).toBe(
      "https://www.linkedin.com/in/my-profile",
    );
    expect(normalizeTwitterX("twitter.com/dev")).toBe("https://x.com/dev");
  });
});

describe("normalizeRegistrationAnswers", () => {
  it("extracts fields from mixed registration answer formats", () => {
    const answers: RegistrationAnswer[] = [
      {
        label: "Which best describes your primary affiliation?",
        answer: "Student",
      },
      {
        label: "What is your LinkedIn profile?",
        value: "linkedin.com/in/test-user",
      },
      {
        label: "What is your GitHub username?",
        answer: "@testuser",
      },
      {
        label: "What is your X (Twitter) handle?",
        answer: "testx",
      },
      {
        label: "What do you want to build?",
        answer:
          "A collaborative coding copilot that tracks team decisions and task ownership.",
      },
      {
        label: "Are you registering as:",
        answer: "Team of 3",
      },
      {
        label: "Team Name (optional — must match exactly for all team members)",
        answer: "Team North Star",
      },
      {
        label: "Have you used Codex before?",
        answer: "Yes, experimented",
      },
      {
        label: "Anything else you’d like to share?",
        answer: "Happy to mentor first-time hackathon participants.",
      },
      {
        label:
          "I understand this is an in-person event in Singapore, and I confirm that I’ll be able to attend.",
        answer: true,
      },
    ];

    const normalized = normalizeRegistrationAnswers(answers);

    expect(normalized.affiliation).toBe("Student");
    expect(normalized.linkedin).toBe("https://linkedin.com/in/test-user");
    expect(normalized.github).toBe("https://github.com/testuser");
    expect(normalized.twitterX).toBe("https://x.com/testx");
    expect(normalized.registrationAs).toBe("Team of 3");
    expect(normalized.teamName).toBe("Team North Star");
    expect(normalized.codexUsage).toBe("Yes, experimented");
    expect(normalized.inPersonConfirmed).toBe(true);
  });

  it("detects solo vs team registrants", () => {
    const solo = normalizeRegistrationAnswers([
      { label: "Are you registering as:", answer: "Solo" },
    ]);

    const team = normalizeRegistrationAnswers([
      { label: "Are you registering as:", answer: "Team of 2" },
    ]);

    expect(inferIsSoloRegistrant(solo)).toBe(true);
    expect(inferIsSoloRegistrant(team)).toBe(false);
  });
});

describe("mapGuestEntryToReviewRecord", () => {
  it("maps guest entries into review records", () => {
    const record = mapGuestEntryToReviewRecord(
      {
        api_id: "gst-123",
        guest: {
          id: "guest-1",
          user_name: "Test User",
          user_email: "test@example.com",
          approval_status: "pending_approval",
          registration_answers: [
            {
              label: "Are you registering as:",
              answer: "Team of 2",
            },
            {
              label: "Team Name (optional — must match exactly for all team members)",
              answer: "Builders",
            },
          ],
          tickets: [
            {
              amount: 25,
              currency: "usd",
              ticket_name: "Standard",
            },
          ],
        },
      },
      {
        eventId: "evt-1",
        eventApiId: "evt-api-1",
      },
    );

    expect(record.apiId).toBe("gst-123");
    expect(record.name).toBe("Test User");
    expect(record.email).toBe("test@example.com");
    expect(record.ticketName).toBe("Standard");
    expect(record.teamNameRaw).toBe("Builders");
    expect(record.teamKey).toBe("builders");
    expect(record.isSoloRegistrant).toBe(false);
  });
});
