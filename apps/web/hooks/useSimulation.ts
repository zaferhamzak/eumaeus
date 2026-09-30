"use client";

import { useMutation } from "@tanstack/react-query";
import { simulate, type SimulationScope, type SimulationTarget } from "@/lib/api/simulations";

export function useSimulation() {
  return useMutation({ mutationFn: ({ target, scope }: { target: SimulationTarget; scope: SimulationScope }) => simulate(target, scope) });
}
