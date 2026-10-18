package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/99designs/gqlgen/graphql/playground"
	"github.com/ckang21/fleet-ops-agent/fleet-sim/graph"
	"github.com/ckang21/fleet-ops-agent/fleet-sim/internal/sim"
)

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return def
}

// cors lets the browser UI (served from another port) call the API.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	scenario := os.Getenv("SIM_SCENARIO")
	s := sim.New(int64(envInt("SIM_SEED", 1)), scenario)
	tick := time.Duration(envInt("SIM_TICK_MS", 1000)) * time.Millisecond

	go func(ctx context.Context) {
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if s.AutoTick() {
					s.Step()
				}
			}
		}
	}(context.Background())

	srv := handler.New(graph.NewExecutableSchema(graph.Config{Resolvers: &graph.Resolver{Sim: s}}))
	srv.AddTransport(transport.GET{})
	srv.AddTransport(transport.POST{})

	http.Handle("/", playground.Handler("Fleet Sim", "/query"))
	http.Handle("/query", cors(srv))
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	log.Printf("fleet-sim on http://localhost:%s (playground at /, tick %s)", port, tick)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
