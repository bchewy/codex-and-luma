# Luma Hackathon Review Dashboard

Local Next.js admin dashboard for reviewing Luma hackathon applicants by team or individual, then approving/declining directly in Luma.

## Features

- Multi-event selector from Luma calendar (`/v1/calendar/list-events`)
- Hackathon-like events prioritized by default
- Team and People review tabs
- Team name normalization + variant warning
- Immediate approve/decline actions against Luma (`/v1/event/update-guest-status`)
- Decline flow supports optional refunds

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env.local
# then edit .env.local with your real key
```

3. Start dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` - start development server
- `npm run lint` - run ESLint
- `npm run test` - run Vitest tests
- `npm run build` - production build
