import {
  createEmptyStatusCounts,
  type GuestReviewRecord,
  type TeamAggregate,
} from "@/lib/luma/types";

interface BuildTeamAggregatesOptions {
  includeSolo?: boolean;
}

export function normalizeTeamName(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .filter(Boolean)
    .map((chunk) => chunk[0].toUpperCase() + chunk.slice(1))
    .join(" ");
}

function pickDisplayName(members: GuestReviewRecord[], normalizedName: string): string {
  const variants = new Map<string, number>();

  for (const member of members) {
    if (!member.teamNameRaw) {
      continue;
    }

    const raw = member.teamNameRaw.trim();
    if (!raw) {
      continue;
    }

    variants.set(raw, (variants.get(raw) ?? 0) + 1);
  }

  const sortedVariants = Array.from(variants.entries()).sort((a, b) => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });

  return sortedVariants[0]?.[0] ?? titleCase(normalizedName);
}

export function buildTeamAggregates(
  records: GuestReviewRecord[],
  options: BuildTeamAggregatesOptions = {},
): TeamAggregate[] {
  const includeSolo = options.includeSolo ?? false;
  const grouped = new Map<string, TeamAggregate>();

  for (const record of records) {
    if (record.isSoloRegistrant && !includeSolo) {
      continue;
    }

    const key = record.teamKey;
    let team = grouped.get(key);

    if (!team) {
      team = {
        key,
        normalizedTeamName: record.teamNameRaw
          ? normalizeTeamName(record.teamNameRaw)
          : null,
        displayName: record.teamNameRaw?.trim() || `Solo · ${record.name || record.email}`,
        rawNameVariants: [],
        members: [],
        isSolo: record.isSoloRegistrant,
        hasNameVariantWarning: false,
        counts: createEmptyStatusCounts(),
      };

      grouped.set(key, team);
    }

    team.members.push(record);
    team.counts[record.approvalStatus] += 1;
    team.counts.total += 1;

    if (record.teamNameRaw) {
      const variant = record.teamNameRaw.trim();
      if (variant && !team.rawNameVariants.includes(variant)) {
        team.rawNameVariants.push(variant);
      }
    }
  }

  const teams = Array.from(grouped.values());

  for (const team of teams) {
    team.rawNameVariants.sort((a, b) => a.localeCompare(b));
    team.hasNameVariantWarning = team.rawNameVariants.length > 1;

    if (!team.isSolo && team.normalizedTeamName) {
      team.displayName = pickDisplayName(team.members, team.normalizedTeamName);
    }
  }

  teams.sort((a, b) => {
    if (a.counts.pending_approval !== b.counts.pending_approval) {
      return b.counts.pending_approval - a.counts.pending_approval;
    }

    if (a.members.length !== b.members.length) {
      return b.members.length - a.members.length;
    }

    return a.displayName.localeCompare(b.displayName);
  });

  return teams;
}
