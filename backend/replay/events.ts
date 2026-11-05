/**
 * The storms the replay is validated on (GAU-138). Windows cover the onset and the peak; the
 * archive starts WARMUP_HOURS earlier so the 3 h L1 history and the 6 h GOES files are full
 * from the first replayed minute. Without the running 1-min Kp estimate (not archived), the
 * replay reaches each G level when its 3-hour Kp interval completes, up to 3 h after live would.
 */
export interface ReplayEvent {
  id: string;
  title: string;
  /** First replayed minute (UTC). */
  start: string;
  /** End of the replay (UTC, exclusive). */
  end: string;
  /** What the record shows, from the archived data (checked when the event was added). */
  expect: string;
}

export const WARMUP_HOURS = 6;

export const REPLAY_EVENTS: ReplayEvent[] = [
  {
    id: "may-2024",
    title: "10–11 May 2024 (Gannon storm)",
    start: "2024-05-10T12:00:00Z",
    end: "2024-05-11T06:00:00Z",
    expect: "G4 from 18–21 UT (Kp 8.67), G5 from 21–24 UT on 10 May and 00–03 UT on 11 May (Kp 9); R3 from 01:17 UT on 11 May (GOES X-ray peak X5.8 at 01:23).",
  },
  {
    id: "oct-2024",
    title: "10 Oct 2024",
    start: "2024-10-10T12:00:00Z",
    end: "2024-10-11T03:00:00Z",
    expect: "G4 from 18–21 UT (Kp 8.33) and 21–24 UT (Kp 9−) on 10 Oct; S3 from 13:20 UT.",
  },
  {
    id: "jan-2026",
    title: "19 Jan 2026 radiation and geomagnetic storm",
    start: "2026-01-19T00:00:00Z",
    end: "2026-01-20T02:00:00Z",
    expect:
      "S4 18:10–20:40 UT (GOES ≥10 MeV peak 36,976 pfu at 19:15); S2–S3 from 04:40 UT while Kp < 5 (G0) " +
      "until the 18–21 UT interval (Kp 8.33, G4), then Kp 9− 21–24 UT.",
  },
];

export const eventById = (id: string) => REPLAY_EVENTS.find((e) => e.id === id);
