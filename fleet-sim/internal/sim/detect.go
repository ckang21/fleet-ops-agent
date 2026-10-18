package sim

import "fmt"

// detect opens incidents for new faults and auto-resolves incidents whose condition has cleared.
func (s *Sim) detect() {
	for _, r := range s.robots {
		if s.tick-r.LastHeartbeat >= HeartbeatTimeout && r.Status != Offline {
			r.Status = Offline
			s.open(HeartbeatLost, r.ID, "", r.CurrentJobID)
		}
		if r.Status == Offline && !r.OutOfService && s.tick-r.LastHeartbeat < HeartbeatTimeout {
			// Radio came back on its own.
			r.Status = Idle
			if r.CurrentJobID != "" {
				r.Status = Working
			}
		}
		if r.Status == Working && r.Battery < LowBatteryLevel {
			s.open(LowBattery, r.ID, "", r.CurrentJobID)
		}
		if r.Status == Working && r.StuckTicks >= StuckThreshold && r.Battery > 0 {
			s.open(Stuck, r.ID, "", r.CurrentJobID)
		}
		if r.FaultCode == SensorFault {
			s.open(SensorFault, r.ID, "", r.CurrentJobID)
		}
	}
	for _, j := range s.jobs {
		if j.Status == InProgress && s.tick-j.StartedAt > JobTimeoutTicks {
			s.open(JobTimeout, j.AssignedRobotID, "", j.ID)
		}
	}
	for _, z := range s.zones {
		if z.Blocked && len(s.stuckNear(z)) >= ZoneBlockMinStuck {
			s.open(ZoneBlocked, "", z.ID, "")
		}
	}
	for _, inc := range s.incidents {
		if inc.Status != Resolved && !s.holds(inc) {
			inc.Status = Resolved
			if inc.Resolution == "" {
				inc.Resolution = "auto: condition cleared"
			}
		}
	}
}

// stuckNear returns WORKING robots that are stuck within NearZoneDist of the zone.
func (s *Sim) stuckNear(z *Zone) []*Robot {
	var out []*Robot
	for _, r := range s.robots {
		if r.Status == Working && r.StuckTicks >= StuckThreshold && z.DistTo(r.Pos) <= NearZoneDist {
			out = append(out, r)
		}
	}
	return out
}

// holds reports whether the condition behind an incident is still true.
func (s *Sim) holds(inc *Incident) bool {
	r := s.robotByID[inc.RobotID]
	switch inc.Type {
	case LowBattery:
		return r != nil && r.Status == Working && r.Battery < LowBatteryLevel
	case Stuck:
		return r != nil && r.Status == Working && r.StuckTicks > 0
	case HeartbeatLost:
		return r != nil && s.tick-r.LastHeartbeat >= HeartbeatTimeout
	case SensorFault:
		return r != nil && r.FaultCode == SensorFault
	case JobTimeout:
		j := s.jobByID[inc.JobID]
		return j != nil && j.Status == InProgress && j.AssignedRobotID == inc.RobotID
	case ZoneBlocked:
		return s.zoneByID[inc.ZoneID].Blocked
	}
	return false
}

// open creates an incident unless an unresolved one already exists for the same subject.
func (s *Sim) open(code FaultCode, robotID, zoneID, jobID string) {
	for _, inc := range s.incidents {
		if inc.Status != Resolved && inc.Type == code && inc.RobotID == robotID && inc.ZoneID == zoneID {
			return
		}
	}
	s.nextIncident++
	s.incidents = append(s.incidents, &Incident{
		ID:         fmt.Sprintf("INC-%04d", s.nextIncident),
		RobotID:    robotID,
		ZoneID:     zoneID,
		JobID:      jobID,
		Type:       code,
		DetectedAt: s.tick,
		Severity:   severityOf[code],
		Status:     Open,
	})
}
