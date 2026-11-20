#!/usr/bin/env python3
"""Tests for the screen time agent: python3 tools/screentime-agent/test_agent.py

Drives Agent with a fake clock, a fake logind/desktop (FakeSystem) and a fake ParentSlop server (FakeApi)
that keeps per-computer running totals the way the real one does.
"""

import importlib.machinery
import importlib.util
import os
import subprocess
import tempfile
import types
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("pst", os.path.join(HERE, "parentslop-screentime"))
spec = importlib.util.spec_from_loader("pst", loader)
pst = importlib.util.module_from_spec(spec)
loader.exec_module(pst)


class Clock:
    def __init__(self):
        self.t = 1_700_000_000.0
        self.date = "2026-11-18"  # a Wednesday

    def __call__(self):
        return self.t


def sess(login, sid="2", active=True, locked=False, idle=False, cls="user", state="active"):
    yn = lambda b: "yes" if b else "no"
    return pst.Session({"Id": sid, "Name": login, "User": "1001", "Active": yn(active), "LockedHint": yn(locked),
                        "IdleHint": yn(idle), "Class": cls, "Type": "wayland", "Remote": "no", "State": state})


class FakeSystem:
    def __init__(self, group=("en", "nadia")):
        self.group = set(group)
        self.current = []
        self.notes = []       # (login, title, body, replace_id)
        self.closed = []      # (login, id, when)
        self.on_screen = {}   # id -> login: banners currently showing
        self.terminated = []
        self.clock = None
        self._id = 0

    def sessions(self):
        return list(self.current)

    def group_members(self, name):
        return set(self.group)

    def notify(self, login, title, body, replace_id=None):
        self.notes.append((login, title, body, replace_id))
        # Like GNOME: replacing a notification that's gone makes a new one.
        if replace_id and replace_id in self.on_screen:
            return replace_id
        self._id += 1
        self.on_screen[self._id] = login
        return self._id

    def close(self, login, nid):
        self.closed.append((login, nid, self.clock() if self.clock else None))
        self.on_screen.pop(nid, None)

    def terminate(self, login):
        self.terminated.append(login)
        self.current = [s for s in self.current if s.login != login]


class FakeApi:
    """The server: allowance per login, bonus, and max() of each computer's running total."""

    def __init__(self, clock):
        self.clock = clock
        self.people = {"en": {"weekday": 60, "weekend": 90, "warn": [15, 5, 1], "grace": 2}}
        self.bonus = {}
        self.usage = {}  # (login, date) -> seconds (this computer)
        self.other = {}  # (login, date) -> seconds on other computers
        self.down = False
        self.reports = []

    def report(self, body):
        if self.down:
            raise urllib.error.URLError("network is unreachable")
        self.reports.append(body)
        date = body["date"]
        members = []
        for login, p in self.people.items():
            key = (login, date)
            self.usage[key] = max(self.usage.get(key, 0), body["usage"].get(login, 0))
            allowance = (p["weekday"]) * 60
            used = self.usage[key] + self.other.get(key, 0)
            members.append({"login": login, "name": login.title(), "remainingSeconds": allowance + self.bonus.get(key, 0) - used,
                            "deviceSeconds": self.usage[key], "weekdayMinutes": p["weekday"], "weekendMinutes": p["weekend"],
                            "warnMinutes": p["warn"], "graceMinutes": p["grace"]})
        return {"date": date, "members": members}


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.state_path = os.path.join(self.dir.name, "state.json")
        self.clock = Clock()
        self.sys = FakeSystem()
        self.sys.clock = self.clock
        self.api = FakeApi(self.clock)
        conf = dict(pst.DEFAULT_CONF, token="x", tick=5, report_every=60)
        self.agent = pst.Agent(conf, self.sys, self.api, clock=self.clock, today=lambda: self.clock.date, state_path=self.state_path)

    def tearDown(self):
        self.dir.cleanup()

    def run_for(self, seconds, step=5):
        end = self.clock.t + seconds
        while self.clock.t < end:
            self.clock.t += step
            self.agent.tick()

    def pam(self, user):
        return pst.pam_check(self.state_path, env={"PAM_USER": user, "PAM_TYPE": "account"}, today=self.clock.date)

    def titles(self):
        return [n[1] for n in self.sys.notes]

    # --- counting ---

    def test_counts_only_unlocked_active_non_idle_sessions(self):
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(600)
        self.assertAlmostEqual(self.agent.state["used"]["en"], 600, delta=5)
        for s in (sess("en", locked=True), sess("en", idle=True), sess("en", active=False, state="online")):
            before = self.agent.state["used"]["en"]
            self.sys.current = [s]
            self.run_for(300)
            self.assertAlmostEqual(self.agent.state["used"]["en"], before, delta=5, msg=repr(s))

    def test_idle_counts_when_configured(self):
        self.agent.conf["count_idle"] = True
        self.agent.tick()
        self.sys.current = [sess("en", idle=True)]
        self.run_for(300)
        self.assertGreater(self.agent.state["used"]["en"], 290)

    def test_two_sessions_count_once_and_gaps_are_capped(self):
        self.agent.tick()
        self.sys.current = [sess("en", "2"), sess("en", "7")]
        self.run_for(100)
        self.assertAlmostEqual(self.agent.state["used"]["en"], 100, delta=5)
        self.clock.t += 3600  # suspended for an hour
        self.agent.tick()
        self.assertLess(self.agent.state["used"]["en"], 125)

    def test_reports_running_totals_and_who_is_on(self):
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(130)
        last = self.api.reports[-1]
        self.assertEqual(last["active"], ["en"])
        self.assertGreater(last["usage"]["en"], 50)
        self.assertEqual(self.agent.state["states"]["en"], "ok")

    # --- warnings, grace, logout ---

    def test_warnings_grace_and_logout(self):
        self.api.people["en"]["weekday"] = 20
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(6 * 60)  # 14 minutes left: crossed 15
        self.assertEqual(self.titles(), ["Screen time check"])
        self.run_for(10 * 60)  # 4 left: crossed 5
        self.assertEqual(self.titles()[-1], "Screen time is almost up")
        self.run_for(3 * 60 + 30)  # under a minute
        self.assertEqual(len([t for t in self.titles() if t == "Screen time is almost up"]), 2, "one warning per threshold")
        self.assertEqual(self.agent.state["states"]["en"], "warning")
        self.assertEqual(self.pam("en"), 0)

        self.run_for(60)  # out of time: grace starts
        self.assertEqual(self.titles()[-1], "Screen time is up!")
        self.assertTrue(any("logged out in 2 minutes" in n[2] for n in self.sys.notes))
        self.assertEqual(self.agent.state["states"]["en"], "grace")
        self.assertEqual(self.sys.terminated, [])
        self.assertEqual(self.pam("en"), 1, "can't start a second session during grace")
        self.run_for(60)
        self.assertRegex(self.sys.notes[-1][2], r"Logging out in [01]:\d\d")
        self.run_for(10)
        self.assertEqual(self.sys.on_screen, {}, "countdown banners are taken down again")
        self.run_for(65)
        self.assertEqual(self.sys.terminated, ["en"])
        self.assertEqual(self.agent.state["states"]["en"], "blocked")
        self.assertEqual(self.pam("en"), 1)
        self.assertEqual(self.pam("nadia"), 0, "others unaffected")
        self.assertEqual(self.pam("bai"), 0)

    def test_relogin_after_logout_gets_short_notice(self):
        self.api.people["en"]["weekday"] = 1
        self.api.people["en"]["grace"] = 0
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(70)
        self.assertEqual(self.sys.terminated, ["en"])
        self.sys.current = [sess("en", "9")]  # back in some other way
        self.run_for(10)
        self.assertEqual(self.titles()[-1], "No screen time left")
        self.assertEqual(self.sys.terminated, ["en"])
        self.run_for(30)
        self.assertEqual(self.sys.terminated, ["en", "en"])

    def test_parent_adds_time_during_grace(self):
        self.api.people["en"]["weekday"] = 10
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(10 * 60 + 10)
        self.assertEqual(self.agent.state["states"]["en"], "grace")
        self.api.bonus[("en", self.clock.date)] = 30 * 60
        self.run_for(65)  # next report picks it up
        self.assertEqual(self.titles()[-1], "More screen time!")
        self.assertEqual(self.agent.state["states"]["en"], "ok")
        self.assertEqual(self.pam("en"), 0)
        self.run_for(120)
        self.assertEqual(self.sys.terminated, [])
        # Warnings re-arm: running low again warns again.
        self.run_for(16 * 60)
        self.assertEqual(self.titles()[-1], "Screen time check")

    def test_logs_in_with_little_time_left_gets_one_urgent_warning(self):
        self.api.people["en"]["weekday"] = 3
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.agent.tick()
        self.assertEqual(self.titles(), ["Screen time is almost up"])
        self.assertIn("3 minutes", self.sys.notes[0][2])

    def test_other_computers_time_counts(self):
        self.api.other[("en", self.clock.date)] = 59 * 60
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(90)
        self.assertEqual(self.agent.state["states"]["en"], "grace")

    def test_blocked_when_out_of_time_while_logged_out(self):
        self.api.other[("en", self.clock.date)] = 61 * 60
        self.agent.tick()
        self.assertEqual(self.agent.state["states"]["en"], "blocked")
        self.assertEqual(self.pam("en"), 1)
        self.assertEqual(self.sys.notes, [])

    def test_banners_close_by_themselves(self):
        """No banner is left on screen over a game: each one is closed after banner_seconds."""
        self.api.people["en"]["weekday"] = 16
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(70)  # 15 min left: first warning
        self.assertEqual(len(self.sys.notes), 1)
        shown_at = self.clock.t
        self.run_for(10)
        self.assertEqual(len(self.sys.closed), 1)
        login, nid, when = self.sys.closed[0]
        self.assertEqual(login, "en")
        self.assertLessEqual(when - shown_at, 8 + 5, "closed within a tick of banner_seconds")
        self.assertEqual(self.sys.on_screen, {})
        # Run through warnings, grace and logout: nothing stays up.
        self.run_for(18 * 60)
        self.assertEqual(self.sys.terminated, ["en"])
        self.assertEqual(self.sys.on_screen, {})
        self.assertGreaterEqual(len(self.sys.closed), len(self.sys.notes) - 1)

    def test_countdown_reappears_while_in_grace(self):
        self.api.people["en"]["weekday"] = 1
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(65)
        self.assertEqual(self.agent.state["states"]["en"], "grace")
        n = len([t for t in self.titles() if t == "Screen time is up!"])
        self.run_for(61)
        self.assertGreaterEqual(len([t for t in self.titles() if t == "Screen time is up!"]), n + 2, "a fresh banner every 30 s")

    def test_banners_can_be_left_up(self):
        self.agent.conf["banner_seconds"] = 0
        self.api.people["en"]["weekday"] = 3
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(30)
        self.assertEqual(self.sys.closed, [])
        self.assertEqual(len(self.sys.on_screen), 1)

    # --- safety ---

    def test_never_touches_accounts_outside_the_group(self):
        self.sys.group = {"nadia"}
        self.api.people["en"]["weekday"] = 0
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(600)
        self.assertEqual(self.sys.terminated, [])
        self.assertEqual(self.pam("en"), 0)
        self.assertNotIn("en", self.agent.state["used"])

    def test_turned_off_on_server_releases_the_block(self):
        self.api.people["en"]["weekday"] = 0
        self.agent.tick()
        self.assertEqual(self.pam("en"), 1)
        del self.api.people["en"]
        self.run_for(65)
        self.assertEqual(self.pam("en"), 0)

    def test_pam_check_fails_open_on_garbage(self):
        with open(self.state_path, "w") as f:
            f.write("{not json")
        self.assertEqual(self.pam("en"), 0)
        self.assertEqual(pst.pam_check(os.path.join(self.dir.name, "missing.json"), env={"PAM_USER": "en"}), 0)
        self.assertEqual(pst.pam_check(self.state_path, env={"PAM_USER": "en", "PAM_TYPE": "session"}), 0)

    # --- offline ---

    def test_offline_keeps_counting_and_enforcing_then_catches_up(self):
        self.api.people["en"]["weekday"] = 10
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(120)
        self.api.down = True
        self.run_for(8 * 60 + 10)
        self.assertEqual(self.agent.state["states"]["en"], "grace")
        self.run_for(125)
        self.assertEqual(self.sys.terminated, ["en"])
        self.api.down = False
        self.run_for(65)
        self.assertGreaterEqual(self.api.usage[("en", self.clock.date)], 600, "server caught up with offline time")

    def test_offline_next_day_uses_plain_allowance(self):
        self.agent.tick()
        self.api.down = True
        self.clock.date = "2026-11-21"  # Saturday
        self.clock.t += 86400
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.agent.tick()
        self.assertEqual(self.agent.state["used"], {})
        self.assertAlmostEqual(self.agent.remaining("en"), 90 * 60, delta=10)

    def test_offline_open_policy_stops_enforcing(self):
        self.agent.conf["offline"] = "open"
        self.api.people["en"]["weekday"] = 0
        self.agent.tick()
        self.assertEqual(self.pam("en"), 1)
        self.api.down = True
        self.run_for(16 * 60, step=60)
        self.assertEqual(self.pam("en"), 0)

    def test_state_survives_restart_and_server_knows_more(self):
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(300)
        os.remove(self.state_path)
        agent2 = pst.Agent(self.agent.conf, self.sys, self.api, clock=self.clock, today=lambda: self.clock.date, state_path=self.state_path)
        agent2.tick()
        self.assertGreaterEqual(agent2.state["used"]["en"], 240, "picked up this computer's total from the server (as of its last report)")

    def test_new_day_resets(self):
        self.api.people["en"]["weekday"] = 1
        self.api.people["en"]["grace"] = 0
        self.agent.tick()
        self.sys.current = [sess("en")]
        self.run_for(70)
        self.assertEqual(self.pam("en"), 1)
        self.clock.date = "2026-11-19"
        self.run_for(5)
        self.assertEqual(self.pam("en"), 0)
        self.assertLess(self.agent.state["used"].get("en", 0), 10)


class ParseTest(unittest.TestCase):
    def test_parses_loginctl(self):
        listing = "    2 1001 en  seat0 tty2 active no -\n  154 1000 bai -     -    active no -\n"
        show = ("Id=154\nUser=1000\nName=bai\nRemote=yes\nType=tty\nClass=user\nActive=yes\nState=active\nIdleHint=no\nLockedHint=no\n\n"
                "Id=2\nUser=1001\nName=en\nRemote=no\nType=wayland\nClass=user\nActive=yes\nState=active\nIdleHint=yes\nLockedHint=yes\n")
        calls = []

        def fake_run(args, **kw):
            calls.append(args)
            return types.SimpleNamespace(stdout=listing if args[1] == "list-sessions" else show, returncode=0)

        orig = subprocess.run
        pst.subprocess.run = fake_run
        try:
            sessions = pst.System().sessions()
        finally:
            pst.subprocess.run = orig
        self.assertEqual(calls[1][3:5], ["2", "154"])
        en = [s for s in sessions if s.login == "en"][0]
        self.assertTrue(en.active and en.locked and en.idle and not en.on_screen())
        bai = [s for s in sessions if s.login == "bai"][0]
        self.assertTrue(bai.on_screen() and bai.remote and bai.uid == 1000)

    def test_durations(self):
        self.assertEqual(pst.fmt_duration(45), "45 seconds")
        self.assertEqual(pst.fmt_duration(299), "5 minutes")
        self.assertEqual(pst.fmt_duration(3900), "1 hour 5 minutes")
        self.assertEqual(pst.fmt_clock(95), "1:35")

    def test_conf(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("# comment\nserver = https://example.test/\ntoken = psd_abc.def\ncount_idle = yes\ntick = 3\n")
        try:
            c = pst.load_conf(f.name)
        finally:
            os.remove(f.name)
        self.assertEqual((c["server"], c["token"], c["count_idle"], c["tick"], c["group"]),
                         ("https://example.test", "psd_abc.def", True, 3, "screentime"))


if __name__ == "__main__":
    unittest.main()
