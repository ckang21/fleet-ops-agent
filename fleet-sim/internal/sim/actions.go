package sim

import (
	"fmt"
	"sort"
)

// ---- Queries. All return copies so callers never touch live state. ----

func (s *Sim) Tick() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tick
}

func (s *Sim) Robots(status *RobotStatus) []Robot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Robot{}
	for _, r := range s.robots {
		if status == nil || r.Status == *status {
			out = append(out, r.clone())
		}
	}
	return out
}

func (s *Sim) Robot(id string) (Robot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.robotByID[id]
	if !ok {
		return Robot{}, false
	}
	return r.clone(), true
}

func (s *Sim) Jobs(status *JobStatus) []Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Job{}
	for _, j := range s.jobs {
		if status == nil || j.Status == *status {
			out = append(out, *j)
		}
	}
	return out
}

func (s *Sim) Incidents(status *IncidentStatus) []Incident {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Incident{}
	for _, inc := range s.incidents {
		if status == nil || inc.Status == *status {
			out = append(out, inc.clone())
		}
	}
	return out
}

func (s *Sim) Zones() []Zone {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Zone, len(s.zones))
	for i, z := range s.zones {
		out[i] = *z
	}
	return out
}

func (s *Sim) History(robotID string, lastTicks int) []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.history[robotID]
	if lastTicks > 0 && len(h) > lastTicks {
		h = h[len(h)-lastTicks:]
	}
	return append([]Snapshot(nil), h...)
}

func (s *Sim) Summary() Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	counts := map[RobotStatus]int{}
	total := 0.0
	for _, r := range s.robots {
		counts[r.Status]++
		total += r.Battery
	}
	sum := Summary{Tick: s.tick, RobotCount: len(s.robots), QueuedJobs: s.countJobs(Queued)}
	for _, st := range []RobotStatus{Idle, Working, Charging, Faulted, Offline} {
		sum.ByStatus = append(sum.ByStatus, StatusCount{st, counts[st]})
	}
	if len(s.robots) > 0 {
		sum.AvgBattery = total / float64(len(s.robots))
	}
	for _, inc := range s.incidents {
		if inc.Status != Resolved {
			sum.OpenIncidents++
		}
	}
	for _, j := range s.jobs {
		if j.Status == Done && s.tick-j.FinishedAt <= 60 {
			sum.Throughput++
		}
	}
	return sum
}

// ---- Actions ----

func (s *Sim) robot(id string) (*Robot, error) {
	r, ok := s.robotByID[id]
	if !ok {
		return nil, fmt.Errorf("robot %q not found", id)
	}
	return r, nil
}

func (s *Sim) incident(id string) (*Incident, error) {
	for _, inc := range s.incidents {
		if inc.ID == id {
			return inc, nil
		}
	}
	return nil, fmt.Errorf("incident %q not found", id)
}

func (s *Sim) zone(id string) (*Zone, error) {
	z, ok := s.zoneByID[id]
	if !ok {
		return nil, fmt.Errorf("zone %q not found", id)
	}
	return z, nil
}

// ReassignJob takes a job off its current robot and gives it to robotID, or to the best idle
// robot when robotID is empty. The previous robot is never picked again for the same job.
func (s *Sim) ReassignJob(jobID, robotID string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.jobByID[jobID]
	if !ok {
		return Job{}, fmt.Errorf("job %q not found", jobID)
	}
	if j.Status == Done {
		return Job{}, fmt.Errorf("job %q is already done", jobID)
	}
	prev := j.AssignedRobotID
	var target *Robot
	if robotID != "" {
		r, err := s.robot(robotID)
		if err != nil {
			return Job{}, err
		}
		if r.ID == prev {
			return Job{}, fmt.Errorf("job %q is already assigned to %s", jobID, robotID)
		}
		if !s.assignable(r) {
			return Job{}, fmt.Errorf("robot %s is not available (status %s, battery %.0f%%)", r.ID, r.Status, r.Battery)
		}
		target = r
	}
	s.unassign(j)
	if target == nil {
		target = s.bestRobotFor(j, prev)
	}
	if target != nil {
		s.assign(j, target)
	}
	return *j, nil
}

func (s *Sim) SendToCharger(robotID string) (Robot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.robot(robotID)
	if err != nil {
		return Robot{}, err
	}
	if r.Status == Offline || r.OutOfService {
		return Robot{}, fmt.Errorf("robot %s is offline", r.ID)
	}
	if j := s.jobByID[r.CurrentJobID]; j != nil {
		s.unassign(j)
	}
	if r.Status != Faulted {
		r.Status = Charging
	}
	return r.clone(), nil
}

// ResetRobot power-cycles the drive: it clears motor jams and degraded drive, but not hardware
// faults like a bad sensor. Unreachable (offline) robots can't be reset remotely.
func (s *Sim) ResetRobot(robotID string) (Robot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.robot(robotID)
	if err != nil {
		return Robot{}, err
	}
	if r.Status == Offline {
		return Robot{}, fmt.Errorf("robot %s is offline and can't be reset remotely", r.ID)
	}
	r.motorJamUntil = 0
	r.slow = false
	r.StuckTicks = 0
	return r.clone(), nil
}

func (s *Sim) SetOutOfService(robotID, reason string) (Robot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.robot(robotID)
	if err != nil {
		return Robot{}, err
	}
	if j := s.jobByID[r.CurrentJobID]; j != nil {
		s.unassign(j)
	}
	r.OutOfService = true
	r.OutOfServiceReason = reason
	r.Status = Offline
	return r.clone(), nil
}

// RerouteAround tells every robot to plan around the zone, requeues jobs that start or end there,
// and returns the robots near the zone.
func (s *Sim) RerouteAround(zoneID string) ([]Robot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	z, err := s.zone(zoneID)
	if err != nil {
		return nil, err
	}
	for _, r := range s.robots {
		if !r.avoids(z.ID) {
			r.AvoidZones = append(r.AvoidZones, z.ID)
		}
	}
	for _, j := range s.jobs {
		if (j.From == z.ID || j.To == z.ID) && (j.Status == Assigned || j.Status == InProgress) {
			s.unassign(j)
		}
	}
	affected := []Robot{}
	for _, r := range s.robots {
		if z.DistTo(r.Pos) <= NearZoneDist+1 {
			r.StuckTicks = 0
			affected = append(affected, r.clone())
		}
	}
	return affected, nil
}

// ClearZone is the operator marking a zone as physically cleared.
func (s *Sim) ClearZone(zoneID string) (Zone, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	z, err := s.zone(zoneID)
	if err != nil {
		return Zone{}, err
	}
	z.Blocked = false
	for _, r := range s.robots {
		kept := r.AvoidZones[:0]
		for _, a := range r.AvoidZones {
			if a != z.ID {
				kept = append(kept, a)
			}
		}
		r.AvoidZones = kept
	}
	return *z, nil
}

func (s *Sim) Escalate(incidentID, note string) (Incident, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inc, err := s.incident(incidentID)
	if err != nil {
		return Incident{}, err
	}
	inc.Escalated = true
	if inc.Status == Open {
		inc.Status = Acked
	}
	inc.Notes = append(inc.Notes, note)
	return inc.clone(), nil
}

func (s *Sim) ResolveIncident(incidentID, resolution string) (Incident, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inc, err := s.incident(incidentID)
	if err != nil {
		return Incident{}, err
	}
	inc.Status = Resolved
	inc.Resolution = resolution
	return inc.clone(), nil
}

// InjectFault plants a fault for demos and evals. Detection happens on later ticks, the same way
// it would for a real fault. durationTicks > 0 makes STUCK and HEARTBEAT_LOST clear on their own;
// count sets how many robots a ZONE_BLOCKED traps (default 3).
func (s *Sim) InjectFault(robotID, zoneID string, code FaultCode, count, durationTicks int) (Injection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inject(robotID, zoneID, code, count, durationTicks)
}

func (s *Sim) pickWorking(n int) []*Robot {
	var pool []*Robot
	for _, r := range s.robots {
		if r.Status == Working && !r.injected && r.CurrentJobID != "" {
			pool = append(pool, r)
		}
	}
	sort.Slice(pool, func(a, b int) bool { return pool[a].ID < pool[b].ID })
	s.rng.Shuffle(len(pool), func(a, b int) { pool[a], pool[b] = pool[b], pool[a] })
	if len(pool) > n {
		pool = pool[:n]
	}
	return pool
}

func (s *Sim) inject(robotID, zoneID string, code FaultCode, count, durationTicks int) (Injection, error) {
	until := -1
	if durationTicks > 0 {
		until = s.tick + durationTicks
	}
	if code == ZoneBlocked {
		if zoneID == "" {
			zoneID = "AISLE_3"
		}
		z, err := s.zone(zoneID)
		if err != nil {
			return Injection{}, err
		}
		if count <= 0 {
			count = 3
		}
		z.Blocked = true
		inj := Injection{FaultCode: code, ZoneID: z.ID, RobotIDs: []string{}}
		if z.MinX == 0 {
			return inj, nil // nothing to the west to trap robots against
		}
		// Park robots just west of the zone with deliveries on the far side, so their route runs
		// straight into the blockage.
		for i, r := range s.pickWorking(count) {
			y := min(z.MaxY, z.MinY+1+i*3)
			r.Pos = Point{z.MinX - 1, y}
			j := s.jobByID[r.CurrentJobID]
			j.To = "DOCK_A"
			if y >= GridSize/2 {
				j.To = "DOCK_B"
			}
			j.Status = InProgress
			if j.StartedAt < 0 {
				j.StartedAt = s.tick
			}
			r.leg = 1
			r.injected = true
			inj.RobotIDs = append(inj.RobotIDs, r.ID)
		}
		return inj, nil
	}

	var r *Robot
	if robotID != "" {
		var err error
		if r, err = s.robot(robotID); err != nil {
			return Injection{}, err
		}
	} else if picked := s.pickWorking(1); len(picked) == 1 {
		r = picked[0]
	} else {
		return Injection{}, fmt.Errorf("no working robot available to inject %s", code)
	}
	r.injected = true
	switch code {
	case LowBattery:
		r.Battery = 12
	case Stuck:
		r.motorJamUntil = until
	case HeartbeatLost:
		r.radioDeadUntil = until
	case SensorFault:
		r.FaultCode = SensorFault
		r.Status = Faulted
	case JobTimeout:
		j := s.jobByID[r.CurrentJobID]
		if j == nil {
			return Injection{}, fmt.Errorf("robot %s has no job to time out", r.ID)
		}
		j.Status = InProgress
		j.StartedAt = s.tick - JobTimeoutTicks
		r.slow = true
	default:
		return Injection{}, fmt.Errorf("unknown fault code %q", code)
	}
	return Injection{FaultCode: code, RobotIDs: []string{r.ID}}, nil
}
