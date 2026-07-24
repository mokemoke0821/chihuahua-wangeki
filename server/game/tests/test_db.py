from django.test import TestCase

from game.models import Match, MatchPlayer


class MatchSaveTest(TestCase):
    def test_save_match_and_players(self):
        m = Match.objects.create(room_code="ABCDE", end_reason="150pts",
                                 winner_name="Alice", player_count=2)
        MatchPlayer.objects.create(match=m, seat=0, name="Alice", final_score=151, is_winner=True)
        MatchPlayer.objects.create(match=m, seat=1, name="Bob", final_score=88, is_winner=False)
        self.assertEqual(Match.objects.count(), 1)
        self.assertEqual(m.players.count(), 2)
        self.assertEqual(m.players.get(is_winner=True).name, "Alice")
