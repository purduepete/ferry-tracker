# Phase 0 findings

## Current status

The committed fixture data models the documented WSDOT identifiers and a representative nested schedule response. Live payload verification still requires a locally configured WSDOT access code.

## Relationship under test

1. A terminal is identified by `TerminalID`.
2. A live vessel location may reference `DepartingTerminalID` and `ArrivingTerminalID`.
3. A schedule terminal combination identifies the same terminal pair and contains sailing times.
4. A sailing may identify its assigned vessel with `VesselID` and `VesselName`.

The Raw JSON view remains part of the POC so undocumented fields, nulls, and alternate nesting stay visible.

## Live verification checklist

- Capture sanitized responses for at least 3 terminal pairs.
- Confirm actual WSDOT date encoding and timezone behavior.
- Record which routes omit vessel assignments.
- Record terminal and vessel IDs that do not join to reference data.
- Replace representative fixtures with sanitized live captures.