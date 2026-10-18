package graph

import (
	"github.com/ckang21/fleet-ops-agent/fleet-sim/graph/model"
	"github.com/ckang21/fleet-ops-agent/fleet-sim/internal/sim"
)

// Converters from simulator types to GraphQL models. Empty strings become null.

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func pos(p sim.Point) *model.Position { return &model.Position{X: p.X, Y: p.Y} }

func toRobot(r sim.Robot) *model.Robot {
	out := &model.Robot{
		ID:                 r.ID,
		Name:               r.Name,
		Type:               model.RobotType(r.Type),
		Status:             model.RobotStatus(r.Status),
		Battery:            r.Battery,
		Position:           pos(r.Pos),
		ZoneID:             strPtr(r.ZoneID),
		CurrentJobID:       strPtr(r.CurrentJobID),
		LastHeartbeat:      r.LastHeartbeat,
		StuckTicks:         r.StuckTicks,
		OutOfService:       r.OutOfService,
		OutOfServiceReason: strPtr(r.OutOfServiceReason),
		AvoidZones:         append([]string{}, r.AvoidZones...),
	}
	if r.FaultCode != "" {
		fc := model.FaultCode(r.FaultCode)
		out.FaultCode = &fc
	}
	return out
}

func toRobots(rs []sim.Robot) []*model.Robot {
	out := make([]*model.Robot, len(rs))
	for i, r := range rs {
		out[i] = toRobot(r)
	}
	return out
}

func toJob(j sim.Job) *model.Job {
	out := &model.Job{
		ID:              j.ID,
		Type:            model.JobType(j.Type),
		From:            j.From,
		To:              j.To,
		Priority:        j.Priority,
		Status:          model.JobStatus(j.Status),
		AssignedRobotID: strPtr(j.AssignedRobotID),
		CreatedAt:       j.CreatedAt,
	}
	if j.StartedAt >= 0 {
		s := j.StartedAt
		out.StartedAt = &s
	}
	return out
}

func toZone(z sim.Zone) *model.Zone {
	return &model.Zone{ID: z.ID, Name: z.Name, MinX: z.MinX, MinY: z.MinY, MaxX: z.MaxX, MaxY: z.MaxY, Blocked: z.Blocked}
}

func toIncident(i sim.Incident) *model.Incident {
	return &model.Incident{
		ID:         i.ID,
		RobotID:    strPtr(i.RobotID),
		ZoneID:     strPtr(i.ZoneID),
		JobID:      strPtr(i.JobID),
		Type:       model.FaultCode(i.Type),
		DetectedAt: i.DetectedAt,
		Severity:   model.Severity(i.Severity),
		Status:     model.IncidentStatus(i.Status),
		Resolution: strPtr(i.Resolution),
		Escalated:  i.Escalated,
		Notes:      append([]string{}, i.Notes...),
	}
}

func toSummary(s sim.Summary) *model.FleetSummary {
	out := &model.FleetSummary{
		Tick:          s.Tick,
		RobotCount:    s.RobotCount,
		AvgBattery:    s.AvgBattery,
		OpenIncidents: s.OpenIncidents,
		QueuedJobs:    s.QueuedJobs,
		Throughput:    s.Throughput,
	}
	for _, c := range s.ByStatus {
		out.ByStatus = append(out.ByStatus, &model.StatusCount{Status: model.RobotStatus(c.Status), Count: c.Count})
	}
	return out
}
