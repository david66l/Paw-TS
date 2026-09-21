export const shared = `Work only inside this workspace. Use Node.js ES modules, built-in libraries only, no package installation or external network. Implement the exact public interfaces below, add your own node:test tests and README usage, and run tests. Do not read outside this workspace. Preserve REQUIREMENTS.md. You have a bounded budget: prefer a small complete implementation over a broad framework. All outputs must be deterministic. Finish the work without asking the user questions.`;

export const tasks = {
  queue: {
    seed: {},
    goal: `${shared}
Build a persistent job queue library with CLI. Implement src/queue.js exporting JobQueue, src/store.js exporting saveQueue(file,queue) and loadQueue(file), and src/cli.js.
JobQueue: constructor({maxAttempts=3}={}); enqueue(payload,{priority=0,key}={}) returns a job {id,payload,priority,key,status,attempts}. IDs are unique strings, status starts pending and attempts 0. Re-enqueuing a supplied key returns the existing job even if completed. dequeue() returns null when empty; otherwise picks highest priority pending job, FIFO for equal priorities, marks running and increments attempts. complete(id,result) only accepts running jobs, marks completed and stores result. fail(id,error) only accepts running jobs, stores error, requeues pending until attempts reaches maxAttempts, then marks failed. get(id) returns job or null. list({status}={}) preserves enqueue order and filters optionally. Unknown IDs or non-running transitions throw. maxAttempts must be a positive integer; priority must be finite. Returned objects must not expose mutable internal state (including nested payload/result).
snapshot() returns a JSON-serializable object. static JobQueue.restore(snapshot) validates it, preserves order/IDs/options/dedupe/results and next ID uniqueness, changes interrupted running jobs to pending without losing attempts. Reject structurally invalid snapshots. saveQueue must atomically replace via same-directory temp+rename and create parent directories. loadQueue missing path gives an empty queue; malformed JSON must throw.
CLI: node src/cli.js <file> add <JSON-payload> [priority] prints added job JSON; list prints job array JSON; next prints next job JSON or null. Persist all mutations. Bad arguments/JSON produce stderr and nonzero exit. Add tests, package.json type module with npm test, README.`,
  },
  ledger: {
    seed: {
      "package.json": '{"type":"module","scripts":{"test":"node --test"}}',
      "src/ledger.js":
        "export function total(rows) { return rows.reduce((s,r)=>s+Number(r.amount),0); }\n",
      "src/cli.js": 'console.log("legacy ledger");\n',
      "README.md": "# Ledger v1\nLegacy total(rows) returns dollars.\n",
    },
    goal: `${shared}
Migrate this v1 ledger into a correct CSV reporting library while preserving total(rows) from src/ledger.js (returns numeric dollars from rows with amount).
Create src/csv.js exporting parseCsv(text): array of object rows using first row as headers. Support UTF-8 BOM, CRLF/LF, quoted commas, doubled quotes and quoted newlines. Skip blank lines; reject unterminated quotes, duplicate headers and row/header column-count mismatch. Empty/whitespace-only input returns [].
src/ledger.js also exports normalizeTransactions(rows) and summarize(transactions,{from,to}={}). Input rows have id,date,category,amount,currency fields. Normalize trims all fields, requires nonempty unique id, actual valid YYYY-MM-DD dates, nonempty category, exactly CNY or USD, amount string matching optional minus + digits + optional decimal of 1 or 2 places. Reject scientific notation, empty, overprecision, unsafe integer cents, impossible dates and duplicates. Return array of {id,date,category,amountCents,currency}; use exact integer cents, including negatives (no float money arithmetic). Do not mutate input.
summarize filters inclusive from/to dates (validate dates and from<=to), returns {count, totals:{CNY:integer,USD:integer}, byCategory:[{category,currency,amountCents,count}]}; group by category AND currency, sorted by category then currency with deterministic code-point order. Empty currency totals are 0. No currency conversion.
src/cli.js: node src/cli.js report <csv-file> [--from YYYY-MM-DD] [--to YYYY-MM-DD] prints exactly summary JSON on stdout. Reject missing/unknown flags, unreadable files and invalid input with stderr and nonzero exit. Add own tests, README examples and v1-to-v2 notes.`,
  },
} as const;
