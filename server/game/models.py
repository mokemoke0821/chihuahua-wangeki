"""models.py — 対戦結果のみDB保存（学習目的の最小構成）。ゲーム進行はメモリ."""
from django.db import models


class Match(models.Model):
    room_code = models.CharField(max_length=8)
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    # 終了理由: wangeki / 150pts / draw / abandoned(流局)
    end_reason = models.CharField(max_length=16, default="")
    winner_name = models.CharField(max_length=32, default="")
    player_count = models.IntegerField(default=0)

    def __str__(self):
        return f"Match#{self.pk} {self.room_code} {self.end_reason} winner={self.winner_name}"


class MatchPlayer(models.Model):
    match = models.ForeignKey(Match, related_name="players", on_delete=models.CASCADE)
    seat = models.IntegerField(default=0)
    name = models.CharField(max_length=32)
    final_score = models.IntegerField(default=0)
    is_winner = models.BooleanField(default=False)

    def __str__(self):
        return f"{self.name}({self.final_score})"
