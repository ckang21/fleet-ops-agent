package sim

import (
	"fmt"
	"math/rand"
	"sort"
	"sync"
)

const (
	GridSize          = 20
	StuckThreshold    = 5  // ticks without moving while WORKING
	HeartbeatTimeout  = 5  // ticks without a heartbeat before OFFLINE
	JobTimeoutTicks   = 90 // ticks IN_PROGRESS before JOB_TIMEOUT
	LowBatteryLevel   = 15.0
	GoChargeBelow     = 30.0
	AssignMinBattery  = 35.0
	ChargeDoneLevel   = 95.0
	DrainWorking      = 0.8
	DrainIdle         = 0.05
	ChargeRate        = 3.0
	NearZoneDist      = 2
	ZoneBlockMinStuck = 2
	HistoryLen        = 120
	RandomFaultRate   = 0.005
)

// Scenario names for Reset.
const (
	ScenarioDefault = "default" // random faults on, for live demos
	ScenarioEval    = "eval"    // random faults off, for reproducible evals
)

var workZones = []string{"DOCK_A", "DOCK_B", "AISLE_1", "AISLE_2", "AISLE_3", "STAGING"}

type Sim struct {
	mu           sync.Mutex
	rng          *rand.Rand
	scenario     string
	randomFaults bool
	autoTick     bool

	tick      int
	robots    []*Robot
	robotByID map[string]*Robot
	jobs      []*Job
	jobByID   map[string]*Job
	zones     []*Zone
	zoneByID  map[string]*Zone
	incidents []*Incident
	history   map[string][]Snapshot

	nextJob      int
	nextIncident int
}

func New(seed int64, scenario string) *Sim {
	s := &Sim{autoTick: true}
	s.reset(seed, scenario)
	return s
}

// Reset rebuilds the fleet from a seed. The same seed and scenario always produce the same run.
func (s *Sim) Reset(seed int64, scenario string, autoTick bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoTick = autoTick
	s.reset(seed, scenario)
}

func (s *Sim) AutoTick() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.autoTick
}

func (s *Sim) reset(seed int64, scenario string) {
	if scenario == "" {
		scenario = ScenarioDefault
	}
	s.rng = rand.New(rand.NewSource(seed))
	s.scenario = scenario
	s.randomFaults = scenario != ScenarioEval
	s.tick = 0
	s.nextJob, s.nextIncident = 0, 0
	s.jobs, s.incidents = nil, nil
	s.jobByID = map[string]*Job{}
	s.history = map[string][]Snapshot{}

	s.zones = []*Zone{
		{ID: "CHARGING_BAY", Name: "Charging bay", MinX: 0, MinY: 0, MaxX: 3, MaxY: 3},
		{ID: "DOCK_A", Name: "Dock A", MinX: 16, MinY: 0, MaxX: 19, MaxY: 3},
		{ID: "DOCK_B", Name: "Dock B", MinX: 16, MinY: 16, MaxX: 19, MaxY: 19},
		{ID: "AISLE_1", Name: "Aisle 1", MinX: 5, MinY: 4, MaxX: 6, MaxY: 15},
		{ID: "AISLE_2", Name: "Aisle 2", MinX: 9, MinY: 4, MaxX: 10, MaxY: 15},
		{ID: "AISLE_3", Name: "Aisle 3", MinX: 13, MinY: 4, MaxX: 14, MaxY: 15},
		{ID: "STAGING", Name: "Staging", MinX: 0, MinY: 16, MaxX: 3, MaxY: 19},
	}
	s.zoneByID = map[string]*Zone{}
	for _, z := range s.zones {
		s.zoneByID[z.ID] = z
	}

	s.robots = nil
	s.robotByID = map[string]*Robot{}
	for i := 1; i <= 16; i++ {
		t := AMR
		if i > 12 {
			t = Forklift
		}
		r := &Robot{
			ID:      fmt.Sprintf("R-%02d", i),
			Name:    fmt.Sprintf("%s-%02d", map[RobotType]string{AMR: "Rover", Forklift: "Lifter"}[t], i),
			Type:    t,
			Status:  Idle,
			Battery: 50 + float64(s.rng.Intn(51)),
			Pos:     s.randomFreeCell(),
		}
		s.robots = append(s.robots, r)
		s.robotByID[r.ID] = r
	}
	for i := 0; i < 10; i++ {
		s.spawnJob()
	}
	s.assignJobs()
	s.updateZones()
	s.record()
}

func (s *Sim) randomFreeCell() Point {
	for {
		p := Point{s.rng.Intn(GridSize), s.rng.Intn(GridSize)}
		if s.zoneAt(p) == nil {
			return p
		}
	}
}

func (s *Sim) zoneAt(p Point) *Zone {
	for _, z := range s.zones {
		if z.Contains(p) {
			return z
		}
	}
	return nil
}

// Step advances the simulation by one tick.
func (s *Sim) Step() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.step()
}

// Advance runs n ticks and returns the new tick count.
func (s *Sim) Advance(n int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := 0; i < n; i++ {
		s.step()
	}
	return s.tick
}

func (s *Sim) step() {
	s.tick++
	for _, r := range s.robots {
		if !active(r.radioDeadUntil, s.tick) {
			r.radioDeadUntil = 0
			r.LastHeartbeat = s.tick
		}
		if !active(r.motorJamUntil, s.tick) {
			r.motorJamUntil = 0
		}
	}
	if s.rng.Float64() < 0.3 && s.countJobs(Queued) < 10 {
		s.spawnJob()
	}
	s.assignJobs()
	for _, r := range s.robots {
		s.moveRobot(r)
	}
	s.updateZones()
	s.detect()
	s.record()
	s.pruneJobs()
	if s.randomFaults && s.rng.Float64() < RandomFaultRate {
		s.injectRandom()
	}
}

// active reports whether a timed fault (0 = none, -1 = permanent, else expiry tick) is still on.
func active(until, tick int) bool { return until == -1 || until > tick }

func (s *Sim) countJobs(st JobStatus) int {
	n := 0
	for _, j := range s.jobs {
		if j.Status == st {
			n++
		}
	}
	return n
}

func (s *Sim) spawnJob() {
	from := workZones[s.rng.Intn(len(workZones))]
	to := workZones[s.rng.Intn(len(workZones))]
	for to == from {
		to = workZones[s.rng.Intn(len(workZones))]
	}
	s.nextJob++
	j := &Job{
		ID:        fmt.Sprintf("J-%04d", s.nextJob),
		Type:      []JobType{Pick, Deliver, Restock}[s.rng.Intn(3)],
		From:      from,
		To:        to,
		Priority:  1 + s.rng.Intn(5),
		Status:    Queued,
		CreatedAt: s.tick,
		StartedAt: -1,
	}
	s.jobs = append(s.jobs, j)
	s.jobByID[j.ID] = j
}

func (s *Sim) jobRoutable(j *Job) bool {
	for _, zid := range []string{j.From, j.To} {
		if s.zoneByID[zid].Blocked {
			return false
		}
	}
	return true
}

func (s *Sim) assignable(r *Robot) bool {
	return r.Status == Idle && !r.OutOfService && r.CurrentJobID == "" && r.Battery >= AssignMinBattery
}

// bestRobotFor picks the nearest assignable robot to the job's pickup zone, skipping `exclude`.
func (s *Sim) bestRobotFor(j *Job, exclude string) *Robot {
	from := s.zoneByID[j.From].Center()
	var best *Robot
	for _, r := range s.robots {
		if r.ID == exclude || !s.assignable(r) {
			continue
		}
		if best == nil || manhattan(r.Pos, from) < manhattan(best.Pos, from) {
			best = r
		}
	}
	return best
}

func (s *Sim) assign(j *Job, r *Robot) {
	j.Status = Assigned
	j.AssignedRobotID = r.ID
	r.Status = Working
	r.CurrentJobID = j.ID
	r.leg = 0
	r.StuckTicks = 0
}

func (s *Sim) assignJobs() {
	queued := []*Job{}
	for _, j := range s.jobs {
		if j.Status == Queued && s.jobRoutable(j) {
			queued = append(queued, j)
		}
	}
	sort.SliceStable(queued, func(a, b int) bool { return queued[a].Priority > queued[b].Priority })
	for _, j := range queued {
		if r := s.bestRobotFor(j, ""); r != nil {
			s.assign(j, r)
		}
	}
}

// unassign returns a job to the queue and frees its robot.
func (s *Sim) unassign(j *Job) {
	if r := s.robotByID[j.AssignedRobotID]; r != nil && r.CurrentJobID == j.ID {
		r.CurrentJobID = ""
		r.leg = 0
		if r.Status == Working {
			r.Status = Idle
		}
	}
	j.Status = Queued
	j.AssignedRobotID = ""
	j.StartedAt = -1
}

func (s *Sim) moveRobot(r *Robot) {
	if r.Status == Offline || r.Status == Faulted {
		return
	}
	if r.Status == Idle && r.Battery < GoChargeBelow && !r.OutOfService {
		r.Status = Charging
	}
	switch r.Status {
	case Charging:
		r.StuckTicks = 0
		bay := s.zoneByID["CHARGING_BAY"]
		if bay.Contains(r.Pos) {
			r.Battery = min(100, r.Battery+ChargeRate)
			if r.Battery >= ChargeDoneLevel {
				r.Status = Idle
			}
			return
		}
		s.stepToward(r, bay.Center())
		r.Battery = max(0, r.Battery-DrainIdle)
	case Idle:
		r.StuckTicks = 0
		r.Battery = max(0, r.Battery-DrainIdle)
	case Working:
		j := s.jobByID[r.CurrentJobID]
		if j == nil {
			r.Status, r.CurrentJobID = Idle, ""
			return
		}
		if j.Status == Assigned {
			j.Status = InProgress
			j.StartedAt = s.tick
		}
		target := s.zoneByID[j.From].Center()
		if r.leg == 1 {
			target = s.zoneByID[j.To].Center()
		}
		if r.Pos == target {
			r.StuckTicks = 0
			if r.leg == 0 {
				r.leg = 1
				return
			}
			j.Status = Done
			j.FinishedAt = s.tick
			r.CurrentJobID, r.leg, r.Status = "", 0, Idle
			return
		}
		if r.Battery <= 0 {
			return // depleted: stops where it is
		}
		if s.stepToward(r, target) {
			r.StuckTicks = 0
		} else {
			r.StuckTicks++
		}
		r.Battery = max(0, r.Battery-DrainWorking)
	}
}

// stepToward moves the robot one cell toward target. It returns false when the robot couldn't
// make progress (motor jam or a blocked zone in the way).
func (s *Sim) stepToward(r *Robot, target Point) bool {
	if active(r.motorJamUntil, s.tick) {
		return false
	}
	if r.slow && s.tick%3 != 0 {
		return true // degraded drive: crawls, but isn't stuck
	}
	next, ok := s.nextCell(r, target)
	if !ok {
		return false
	}
	if z := s.zoneAt(next); z != nil && z.Blocked {
		return false
	}
	r.Pos = next
	return true
}

// nextCell uses a straight L-shaped route (x first, then y) unless the robot has been told to
// avoid zones, in which case it plans a path around them with BFS.
func (s *Sim) nextCell(r *Robot, target Point) (Point, bool) {
	greedy := r.Pos
	if r.Pos.X != target.X {
		greedy.X += sign(target.X - r.Pos.X)
	} else {
		greedy.Y += sign(target.Y - r.Pos.Y)
	}
	if len(r.AvoidZones) == 0 {
		return greedy, true
	}
	if p, ok := s.bfs(r, target); ok {
		return p, true
	}
	return greedy, true
}

func sign(n int) int {
	switch {
	case n > 0:
		return 1
	case n < 0:
		return -1
	}
	return 0
}

func (s *Sim) passable(r *Robot, p Point, target Point) bool {
	if p.X < 0 || p.Y < 0 || p.X >= GridSize || p.Y >= GridSize {
		return false
	}
	if p == target {
		return true
	}
	z := s.zoneAt(p)
	return z == nil || (!z.Blocked && !r.avoids(z.ID))
}

func (s *Sim) bfs(r *Robot, target Point) (Point, bool) {
	dirs := []Point{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
	prev := map[Point]Point{r.Pos: r.Pos}
	queue := []Point{r.Pos}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == target {
			for prev[cur] != r.Pos {
				cur = prev[cur]
			}
			return cur, true
		}
		for _, d := range dirs {
			n := Point{cur.X + d.X, cur.Y + d.Y}
			if _, seen := prev[n]; seen || !s.passable(r, n, target) {
				continue
			}
			prev[n] = cur
			queue = append(queue, n)
		}
	}
	return Point{}, false
}

func (s *Sim) updateZones() {
	for _, r := range s.robots {
		r.ZoneID = ""
		if z := s.zoneAt(r.Pos); z != nil {
			r.ZoneID = z.ID
		}
	}
}

func (s *Sim) record() {
	for _, r := range s.robots {
		h := append(s.history[r.ID], Snapshot{Tick: s.tick, Pos: r.Pos, Battery: r.Battery, Status: r.Status})
		if len(h) > HistoryLen {
			h = h[len(h)-HistoryLen:]
		}
		s.history[r.ID] = h
	}
}

// pruneJobs drops finished jobs older than 300 ticks so the job list stays small.
func (s *Sim) pruneJobs() {
	kept := s.jobs[:0]
	for _, j := range s.jobs {
		if j.Status == Done && s.tick-j.FinishedAt > 300 {
			delete(s.jobByID, j.ID)
			continue
		}
		kept = append(kept, j)
	}
	s.jobs = kept
}

func (s *Sim) injectRandom() {
	codes := []FaultCode{LowBattery, Stuck, HeartbeatLost, JobTimeout, SensorFault, ZoneBlocked}
	code := codes[s.rng.Intn(len(codes))]
	zone := ""
	if code == ZoneBlocked {
		zone = []string{"AISLE_1", "AISLE_2", "AISLE_3"}[s.rng.Intn(3)]
	}
	_, _ = s.inject("", zone, code, 0, 0)
}
