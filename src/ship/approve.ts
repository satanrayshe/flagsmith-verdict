import readline from 'node:readline';

export class NoTtyError extends Error {
  constructor() {
    super('verdict ship changes what your users see, so it needs a person at a terminal to approve it. No terminal is attached (stdin or stdout is not a TTY). Nothing was changed.');
  }
}

export interface ApprovalIo {
  isTTY: boolean;
  ask(question: string): Promise<string>;
}

export function terminalIo(): ApprovalIo {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask(question) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
    },
  };
}

/**
 * Asks the human to type the experiment name. Only an exact match approves.
 * There is deliberately no flag or environment variable that skips this.
 */
export async function requestApproval(experimentName: string, io: ApprovalIo): Promise<boolean> {
  if (!io.isTTY) throw new NoTtyError();
  const answer = await io.ask(`Type the experiment name to approve (${experimentName}): `);
  return answer.trim() === experimentName;
}
