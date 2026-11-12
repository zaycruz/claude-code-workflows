---------------------------- MODULE RedBlueLoop ----------------------------
(* The control flow of red-blue-loop.js: rounds of find -> dedup -> prove -> verify, then fix.
   One variable per thing the code tracks; one action per code step:
     Find       the lens finders report any subset of suspicions; plain-code dedup against `seen`
     ProveOk    the checks runner saw the red command fail twice (proof := TRUE)
     ProveDrop  no test, touched code, unproven or flaky: dropped, and stays in `seen`
     Confirm    2 of 3 skeptics upheld it          Refute   they did not
     EndRound   stop when the round confirmed nothing new, or after MaxRounds
     Fix        clanker-loop on a confirmed finding (passes or not)
   Mut selects one broken variant; each must break the property named next to it in run-tlc.mjs.
   Bounds (in the .cfg files): 3 suspicions, 1 of them known from an earlier run, MaxRounds 2. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Sus, Known, MaxRounds, Mut

VARIABLES st, proof, upheld, tries, round, phase, newly, merged
vars == <<st, proof, upheld, tries, round, phase, newly, merged>>

States == {"new", "seen", "proven", "confirmed", "dropped", "refuted", "fixed", "fixFailed"}

Init ==
  /\ st = [s \in Sus |-> IF s \in Known THEN "dropped" ELSE "new"]   \* known = already in `seen`
  /\ proof = [s \in Sus |-> FALSE]
  /\ upheld = [s \in Sus |-> FALSE]
  /\ tries = [s \in Sus |-> 0]
  /\ round = 1
  /\ phase = "find"
  /\ newly = 0
  /\ merged = FALSE

\* Dedup: only suspicions never seen before are tried. Mut "nodedup" tries everything reported again.
Fresh(F) == IF Mut = "nodedup" THEN {s \in F : st[s] \in {"new", "dropped", "refuted"}} ELSE {s \in F : st[s] = "new"}

Find ==
  /\ phase = "find"
  /\ \E F \in SUBSET Sus :
       /\ st' = [s \in Sus |-> IF s \in Fresh(F) THEN "seen" ELSE st[s]]
       /\ tries' = [s \in Sus |-> IF s \in Fresh(F) THEN tries[s] + 1 ELSE tries[s]]
  /\ phase' = "prove"
  /\ newly' = 0
  /\ UNCHANGED <<proof, upheld, round, merged>>

ProveOk(s) ==
  /\ phase = "prove" /\ st[s] = "seen"
  /\ st' = [st EXCEPT ![s] = "proven"]
  /\ proof' = [proof EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<upheld, tries, round, phase, newly, merged>>

ProveDrop(s) ==
  /\ phase = "prove" /\ st[s] = "seen"
  /\ st' = [st EXCEPT ![s] = "dropped"]
  /\ UNCHANGED <<proof, upheld, tries, round, phase, newly, merged>>

\* Mut "confirmunproven" lets a suspicion be confirmed without a failing red command.
Confirm(s) ==
  /\ phase = "prove"
  /\ IF Mut = "confirmunproven" THEN st[s] \in {"seen", "proven"} ELSE st[s] = "proven"
  /\ st' = [st EXCEPT ![s] = "confirmed"]
  /\ upheld' = [upheld EXCEPT ![s] = TRUE]
  /\ newly' = newly + 1
  /\ UNCHANGED <<proof, tries, round, phase, merged>>

Refute(s) ==
  /\ phase = "prove" /\ st[s] = "proven"
  /\ st' = [st EXCEPT ![s] = "refuted"]
  /\ UNCHANGED <<proof, upheld, tries, round, phase, newly, merged>>

\* Mut "nostop" keeps going after a dry round; Mut "nobound" ignores MaxRounds.
Stop == \/ (newly = 0 /\ Mut # "nostop")
        \/ (round >= MaxRounds /\ Mut # "nobound")
EndRound ==
  /\ phase = "prove"
  /\ \A s \in Sus : st[s] \notin {"seen", "proven"}
  /\ IF Stop THEN phase' = "fix" /\ round' = round
             ELSE phase' = "find" /\ round' = round + 1
  /\ UNCHANGED <<st, proof, upheld, tries, newly, merged>>

\* Mut "fixunconfirmed" also sends refuted findings to the fix.
Fix(s) ==
  /\ phase = "fix"
  /\ IF Mut = "fixunconfirmed" THEN st[s] \in {"confirmed", "refuted"} ELSE st[s] = "confirmed"
  /\ \E r \in {"fixed", "fixFailed"} : st' = [st EXCEPT ![s] = r]
  /\ UNCHANGED <<proof, upheld, tries, round, phase, newly, merged>>

Done ==
  /\ phase = "fix"
  /\ \A s \in Sus : st[s] # "confirmed"
  /\ phase' = "done"
  /\ UNCHANGED <<st, proof, upheld, tries, round, newly, merged>>

\* Mut "merge" adds the step the workflow must never have.
Merge ==
  /\ Mut = "merge" /\ phase = "done" /\ \E s \in Sus : st[s] = "fixed"
  /\ merged' = TRUE
  /\ UNCHANGED <<st, proof, upheld, tries, round, phase, newly>>

\* A finished run stays finished (not a deadlock).
Finished == phase = "done" /\ UNCHANGED vars

Next ==
  \/ Find \/ EndRound \/ Done \/ Merge \/ Finished
  \/ \E s \in Sus : ProveOk(s) \/ ProveDrop(s) \/ Confirm(s) \/ Refute(s) \/ Fix(s)

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* ---- properties ----
TypeOK == st \in [Sus -> States] /\ phase \in {"find", "prove", "fix", "done"} /\ round \in 1..(MaxRounds + 2)
\* A confirmed (or fixed) finding had a red command that failed twice.
ConfirmedIsProven == \A s \in Sus : st[s] \in {"confirmed", "fixed", "fixFailed"} => proof[s]
\* Only a finding the skeptics upheld reaches the fix.
FixOnlyConfirmed == \A s \in Sus : st[s] \in {"fixed", "fixFailed"} => upheld[s]
\* No suspicion is tried twice, and one known from an earlier run is never tried.
NoRework == \A s \in Sus : tries[s] <= 1 /\ (s \in Known => tries[s] = 0)
\* Never more than MaxRounds rounds.
RoundBound == round <= MaxRounds
\* A new round starts only after a round that confirmed something.
DryStops == (phase = "find" /\ round > 1) => newly > 0
\* Nothing merges.
NoMerge == merged = FALSE
\* Every run ends.
Terminates == <>(phase = "done")
=============================================================================
