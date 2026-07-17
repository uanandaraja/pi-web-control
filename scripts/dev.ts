export {};

const children = [
  Bun.spawn(["bun", "run", "dev:server"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "dev:web"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let closing = false;

function closeChildren(): void {
  if (closing) return;
  closing = true;
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", closeChildren);
process.on("SIGTERM", closeChildren);

const exitCode = await Promise.race(children.map((child) => child.exited));
closeChildren();
process.exit(exitCode);
