// Legal gates: code-level locks that keep Stimuli Network tooling testnet-only
// and fee-free until a lawyer has signed off. Not legal advice.
//
// Decisions (Adrian, 2026-11-23): "I want to be as safe and compliant as possible."
//   - No fees at all during testnet/beta. Fee code paths stay off until a
//     Minnesota fintech / money-transmission attorney signs off in writing.
//     Even then, a fee is invoiced separately and is NEVER an escrow output:
//     the verifier policy refuses any output to an operator address whatever
//     these gates say (src/kaspa/policy.ts).
//   - Mainnet stays refused (escrow building, proof signing, co-signing) until
//     legal review is complete.
//
// How to change a gate: only in a reviewed pull request that links the written
// attorney sign-off (stored privately, not in this repo) and updates
// docs/compliance.md. There is deliberately no environment variable or CLI
// flag for these: a config change must be a visible, reviewed code change.
// Library callers may pass their own `gates` (tests do), but every entry point
// in this repository uses LEGAL_GATES.

export interface LegalGates {
  /** Set true only after a written legal review approves mainnet use. */
  readonly mainnetLegalReviewComplete: boolean;
  /** Set true only after a written attorney sign-off on a specific fee model. */
  readonly feesAttorneySignoff: boolean;
}

export const LEGAL_GATES: LegalGates = Object.freeze({
  mainnetLegalReviewComplete: false,
  feesAttorneySignoff: false,
});

/** Mainnet needs both the caller's explicit opt-in and the legal-review gate. */
export function mainnetAllowed(optIn: boolean | undefined, gates: LegalGates = LEGAL_GATES): boolean {
  return optIn === true && gates.mainnetLegalReviewComplete === true;
}

export const MAINNET_REFUSED = "mainnet is disabled: Stimuli Network tooling is testnet-only until legal review (src/compliance/gates.ts)";

/**
 * Fee code paths call this first. There are no fee code paths today; when one
 * is added it must be an invoice outside the escrow, never an escrow output.
 */
export function assertFeesAllowed(gates: LegalGates = LEGAL_GATES): void {
  if (gates.feesAttorneySignoff !== true) {
    throw new Error("fees are disabled: no fees during testnet/beta, and none until an attorney signs off (src/compliance/gates.ts)");
  }
}
