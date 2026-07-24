from django.contrib import admin

from .models import Match, MatchPlayer


class MatchPlayerInline(admin.TabularInline):
    model = MatchPlayer
    extra = 0


@admin.register(Match)
class MatchAdmin(admin.ModelAdmin):
    list_display = ("id", "room_code", "end_reason", "winner_name", "player_count", "started_at", "ended_at")
    inlines = [MatchPlayerInline]


@admin.register(MatchPlayer)
class MatchPlayerAdmin(admin.ModelAdmin):
    list_display = ("id", "match", "seat", "name", "final_score", "is_winner")
