/**
 * The frozen contract. Every other module imports from here (or from the three
 * files directly); nothing else in `src/` may redefine these shapes.
 *
 * READ-ONLY after Stage 1 — see `contract_change_requests`.
 */
export * from './types.js'
export * from './errors.js'
export * from './paths.js'
