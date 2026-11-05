/** Typed fixture payloads shared by the view tests. */
export type RunRowFixture = {
  run_id: string;
  status: string;
  owner_node: string;
  stack_on?: string;
  created_at: string;
  updated_at: string;
};

export type StatusListFixture = { runs: RunRowFixture[] };

export const statusList: StatusListFixture = {
  runs: [
    {
      run_id: "r-old",
      status: "finished",
      owner_node: "n1",
      created_at: "2026-11-01T10:00:00.000Z",
      updated_at: "2026-11-01T11:00:00.000Z",
    },
    {
      run_id: "r-live",
      status: "running",
      owner_node: "n1",
      created_at: "2026-11-05T09:00:00.000Z",
      updated_at: "2026-11-05T09:30:00.000Z",
    },
    {
      run_id: "r/child 1",
      status: "paused",
      owner_node: "n1",
      stack_on: "r-live",
      created_at: "2026-11-04T09:00:00.000Z",
      updated_at: "2026-11-04T09:30:00.000Z",
    },
  ],
};
