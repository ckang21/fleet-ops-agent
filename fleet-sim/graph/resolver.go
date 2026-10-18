package graph

import "github.com/ckang21/fleet-ops-agent/fleet-sim/internal/sim"

// Resolver is the root GraphQL resolver. All state lives in the simulator.
type Resolver struct {
	Sim *sim.Sim
}
