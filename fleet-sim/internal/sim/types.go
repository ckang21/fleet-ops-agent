// Package sim is an in-memory, tick-based simulation of a warehouse robot fleet.
package sim

type RobotType string

const (
	AMR      RobotType = "AMR"
	Forklift RobotType = "FORKLIFT"
)

type RobotStatus string

const (
	Idle     RobotStatus = "IDLE"
	Working  RobotStatus = "WORKING"
	Charging RobotStatus = "CHARGING"
	Faulted  RobotStatus = "FAULTED"
	Offline  RobotStatus = "OFFLINE"
)

type JobType string

const (
	Pick    JobType = "PICK"
	Deliver JobType = "DELIVER"
	Restock JobType = "RESTOCK"
)

type JobStatus string

const (
	Queued     JobStatus = "QUEUED"
	Assigned   JobStatus = "ASSIGNED"
	InProgress JobStatus = "IN_PROGRESS"
	Done       JobStatus = "DONE"
	Failed     JobStatus = "FAILED"
)

type IncidentStatus string

const (
	Open     IncidentStatus = "OPEN"
	Acked    IncidentStatus = "ACKED"
	Resolved IncidentStatus = "RESOLVED"
)

type Severity string

const (
	Low      Severity = "LOW"
	Medium   Severity = "MEDIUM"
	High     Severity = "HIGH"
	Critical Severity = "CRITICAL"
)

type FaultCode string

const (
	LowBattery    FaultCode = "LOW_BATTERY"
	Stuck         FaultCode = "STUCK"
	HeartbeatLost FaultCode = "HEARTBEAT_LOST"
	ZoneBlocked   FaultCode = "ZONE_BLOCKED"
	JobTimeout    FaultCode = "JOB_TIMEOUT"
	SensorFault   FaultCode = "SENSOR_FAULT"
)

var severityOf = map[FaultCode]Severity{
	LowBattery:    Medium,
	Stuck:         Medium,
	HeartbeatLost: High,
	ZoneBlocked:   High,
	JobTimeout:    Low,
	SensorFault:   High,
}

type Point struct{ X, Y int }

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func manhattan(a, b Point) int { return abs(a.X-b.X) + abs(a.Y-b.Y) }

type Robot struct {
	ID                 string
	Name               string
	Type               RobotType
	Status             RobotStatus
	Battery            float64
	Pos                Point
	ZoneID             string
	CurrentJobID       string
	LastHeartbeat      int
	FaultCode          FaultCode
	StuckTicks         int
	OutOfService       bool
	OutOfServiceReason string
	AvoidZones         []string

	// Hidden fault state. The agent can only infer these from symptoms.
	motorJamUntil  int // 0 = none, -1 = until reset, else tick when it clears
	radioDeadUntil int // same encoding as motorJamUntil
	slow           bool
	leg            int // 0 = heading to job.From, 1 = heading to job.To
	injected       bool
}

func (r *Robot) clone() Robot {
	c := *r
	c.AvoidZones = append([]string(nil), r.AvoidZones...)
	return c
}

func (r *Robot) avoids(zoneID string) bool {
	for _, z := range r.AvoidZones {
		if z == zoneID {
			return true
		}
	}
	return false
}

type Job struct {
	ID              string
	Type            JobType
	From            string
	To              string
	Priority        int
	Status          JobStatus
	AssignedRobotID string
	CreatedAt       int
	StartedAt       int // -1 until the job starts
	FinishedAt      int
}

type Zone struct {
	ID                     string
	Name                   string
	MinX, MinY, MaxX, MaxY int
	Blocked                bool
}

func (z *Zone) Contains(p Point) bool {
	return p.X >= z.MinX && p.X <= z.MaxX && p.Y >= z.MinY && p.Y <= z.MaxY
}

func (z *Zone) Center() Point { return Point{(z.MinX + z.MaxX) / 2, (z.MinY + z.MaxY) / 2} }

// DistTo is the Chebyshev distance from p to the zone rectangle (0 when inside).
func (z *Zone) DistTo(p Point) int {
	dx, dy := 0, 0
	if p.X < z.MinX {
		dx = z.MinX - p.X
	} else if p.X > z.MaxX {
		dx = p.X - z.MaxX
	}
	if p.Y < z.MinY {
		dy = z.MinY - p.Y
	} else if p.Y > z.MaxY {
		dy = p.Y - z.MaxY
	}
	if dx > dy {
		return dx
	}
	return dy
}

type Incident struct {
	ID         string
	RobotID    string
	ZoneID     string
	JobID      string
	Type       FaultCode
	DetectedAt int
	Severity   Severity
	Status     IncidentStatus
	Resolution string
	Escalated  bool
	Notes      []string
}

func (i *Incident) clone() Incident {
	c := *i
	c.Notes = append([]string(nil), i.Notes...)
	return c
}

type Snapshot struct {
	Tick    int
	Pos     Point
	Battery float64
	Status  RobotStatus
}

type StatusCount struct {
	Status RobotStatus
	Count  int
}

type Summary struct {
	Tick          int
	RobotCount    int
	ByStatus      []StatusCount
	AvgBattery    float64
	OpenIncidents int
	QueuedJobs    int
	Throughput    int // jobs completed in the last 60 ticks
}

type Injection struct {
	FaultCode FaultCode
	RobotIDs  []string
	ZoneID    string
}
