package sim

import (
	"reflect"
	"testing"
)

func newEval(t *testing.T) *Sim {
	t.Helper()
	s := New(42, ScenarioEval)
	s.Advance(3)
	return s
}

func openOf(s *Sim, code FaultCode) []Incident {
	var out []Incident
	for _, inc := range s.Incidents(nil) {
		if inc.Type == code && inc.Status != Resolved {
			out = append(out, inc)
		}
	}
	return out
}

func TestSameSeedSameRun(t *testing.T) {
	a, b := New(7, ScenarioEval), New(7, ScenarioEval)
	a.Advance(50)
	b.Advance(50)
	if !reflect.DeepEqual(a.Robots(nil), b.Robots(nil)) {
		t.Fatal("same seed produced different robot state")
	}
}

func TestGreedyMovementIsXThenY(t *testing.T) {
	s := New(1, ScenarioEval)
	r := &Robot{Pos: Point{4, 17}}
	if p, _ := s.nextCell(r, Point{8, 18}); p != (Point{5, 17}) {
		t.Fatalf("expected to move along x first, got %v", p)
	}
	r.Pos = Point{8, 17}
	if p, _ := s.nextCell(r, Point{8, 18}); p != (Point{8, 18}) {
		t.Fatalf("expected to move along y once x matches, got %v", p)
	}
}

func TestBatteryDrainsWhileWorkingAndCharges(t *testing.T) {
	s := New(1, ScenarioEval)
	r := s.robotByID["R-01"]
	r.Status, r.Battery, r.CurrentJobID = Idle, 20, ""
	r.Pos = s.zoneByID["CHARGING_BAY"].Center()
	s.moveRobot(r)
	if r.Status != Charging || r.Battery <= 20 {
		t.Fatalf("low idle robot in the bay should charge, got %s %.1f", r.Status, r.Battery)
	}

	w := s.robotByID["R-02"]
	if w.Status != Working {
		t.Skip("R-02 not working in this seed")
	}
	before := w.Battery
	s.moveRobot(w)
	if w.Battery >= before {
		t.Fatalf("working robot should drain battery: %.1f -> %.1f", before, w.Battery)
	}
}

func TestLowBatteryDetected(t *testing.T) {
	s := newEval(t)
	inj, err := s.InjectFault("", "", LowBattery, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	s.Advance(1)
	got := openOf(s, LowBattery)
	if len(got) != 1 || got[0].RobotID != inj.RobotIDs[0] {
		t.Fatalf("expected one LOW_BATTERY incident for %v, got %+v", inj.RobotIDs, got)
	}
}

func TestLowBatteryOnIdleRobotIsNotAnIncident(t *testing.T) {
	s := newEval(t)
	var idle string
	for _, r := range s.Robots(nil) {
		if r.Status == Idle {
			idle = r.ID
			break
		}
	}
	if idle == "" {
		t.Skip("no idle robot in this seed")
	}
	if _, err := s.InjectFault(idle, "", LowBattery, 0, 0); err != nil {
		t.Fatal(err)
	}
	s.Advance(5)
	if got := openOf(s, LowBattery); len(got) != 0 {
		t.Fatalf("idle robot with low battery should just go charge, got %+v", got)
	}
}

func TestStuckDetectedAndResetClearsIt(t *testing.T) {
	s := newEval(t)
	inj, _ := s.InjectFault("", "", Stuck, 0, 0)
	s.Advance(StuckThreshold + 1)
	if len(openOf(s, Stuck)) != 1 {
		t.Fatal("expected a STUCK incident")
	}
	if _, err := s.ResetRobot(inj.RobotIDs[0]); err != nil {
		t.Fatal(err)
	}
	s.Advance(2)
	if len(openOf(s, Stuck)) != 0 {
		t.Fatal("STUCK incident should auto-resolve once the robot moves again")
	}
}

func TestTransientStuckClearsOnItsOwn(t *testing.T) {
	s := newEval(t)
	s.InjectFault("", "", Stuck, 0, StuckThreshold+3)
	s.Advance(StuckThreshold + 1)
	if len(openOf(s, Stuck)) != 1 {
		t.Fatal("expected a STUCK incident while jammed")
	}
	s.Advance(5)
	if len(openOf(s, Stuck)) != 0 {
		t.Fatal("expected the STUCK incident to clear once the jam expired")
	}
}

func TestHeartbeatLostGoesOffline(t *testing.T) {
	s := newEval(t)
	inj, _ := s.InjectFault("", "", HeartbeatLost, 0, 0)
	s.Advance(HeartbeatTimeout + 1)
	r, _ := s.Robot(inj.RobotIDs[0])
	if r.Status != Offline || len(openOf(s, HeartbeatLost)) != 1 {
		t.Fatalf("expected OFFLINE robot and HEARTBEAT_LOST incident, got %s", r.Status)
	}
	if _, err := s.ResetRobot(r.ID); err == nil {
		t.Fatal("offline robot should not be resettable")
	}
}

func TestSensorFault(t *testing.T) {
	s := newEval(t)
	inj, _ := s.InjectFault("", "", SensorFault, 0, 0)
	s.Advance(1)
	if len(openOf(s, SensorFault)) != 1 {
		t.Fatal("expected a SENSOR_FAULT incident")
	}
	s.ResetRobot(inj.RobotIDs[0])
	s.Advance(1)
	if len(openOf(s, SensorFault)) != 1 {
		t.Fatal("a reset must not fix a hardware sensor fault")
	}
	s.SetOutOfService(inj.RobotIDs[0], "sensor fault")
	r, _ := s.Robot(inj.RobotIDs[0])
	if !r.OutOfService || r.CurrentJobID != "" {
		t.Fatal("out-of-service robot should drop its job")
	}
}

func TestJobTimeoutAndReassign(t *testing.T) {
	s := newEval(t)
	inj, _ := s.InjectFault("", "", JobTimeout, 0, 0)
	s.Advance(2)
	got := openOf(s, JobTimeout)
	if len(got) != 1 {
		t.Fatal("expected a JOB_TIMEOUT incident")
	}
	j, err := s.ReassignJob(got[0].JobID, "")
	if err != nil {
		t.Fatal(err)
	}
	if j.AssignedRobotID == inj.RobotIDs[0] {
		t.Fatal("reassign must not give the job back to the same robot")
	}
}

func TestZoneBlockedGroupsStuckRobotsAndRerouteFixesThem(t *testing.T) {
	s := newEval(t)
	inj, err := s.InjectFault("", "AISLE_3", ZoneBlocked, 3, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(inj.RobotIDs) < 2 {
		t.Fatalf("expected at least 2 trapped robots, got %v", inj.RobotIDs)
	}
	s.Advance(StuckThreshold + 1)
	if len(openOf(s, ZoneBlocked)) != 1 {
		t.Fatal("expected one ZONE_BLOCKED incident")
	}
	// Robots passing through the aisle on their own can get trapped too, so expect at least the planted ones.
	if n := len(openOf(s, Stuck)); n < len(inj.RobotIDs) {
		t.Fatalf("expected at least %d STUCK incidents, got %d", len(inj.RobotIDs), n)
	}
	if _, err := s.RerouteAround("AISLE_3"); err != nil {
		t.Fatal(err)
	}
	s.Advance(3)
	if n := len(openOf(s, Stuck)); n != 0 {
		t.Fatalf("rerouted robots should be moving again, %d still stuck", n)
	}
	if len(openOf(s, ZoneBlocked)) != 1 {
		t.Fatal("the zone itself stays blocked until an operator clears it")
	}
	s.ClearZone("AISLE_3")
	s.Advance(1)
	if len(openOf(s, ZoneBlocked)) != 0 {
		t.Fatal("clearing the zone should resolve the ZONE_BLOCKED incident")
	}
}

func TestZoneBlockNeedsTwoStuckRobots(t *testing.T) {
	s := newEval(t)
	z := s.zoneByID["AISLE_2"]
	z.Blocked = true
	r := s.robotByID["R-01"]
	r.Status, r.StuckTicks, r.Pos = Working, StuckThreshold, Point{z.MinX - 1, z.MinY}
	s.detect()
	if len(openOf(s, ZoneBlocked)) != 0 {
		t.Fatal("one stuck robot is not enough evidence for ZONE_BLOCKED")
	}
	r2 := s.robotByID["R-02"]
	r2.Status, r2.StuckTicks, r2.Pos = Working, StuckThreshold, Point{z.MinX - 1, z.MinY + 2}
	s.detect()
	if len(openOf(s, ZoneBlocked)) != 1 {
		t.Fatal("two stuck robots at a blocked zone should open ZONE_BLOCKED")
	}
}
