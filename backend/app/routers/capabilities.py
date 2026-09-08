# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Server capability advertisement.

The frontend reads this to decide which controls to render. It is
unauthenticated because it exposes only which features a deployment has
switched on, never any project or user data -- and the SPA needs it before a
session exists in order to lay out its own navigation.
"""

from fastapi import APIRouter

from ..features import capabilities

router = APIRouter(prefix="/api/capabilities", tags=["capabilities"])


@router.get("")
def get_capabilities():
    """Which optional features this server has enabled.

    Clients must treat an absent key as disabled, so that a newer frontend
    talking to an older server does not render a control the backend will
    reject.
    """
    return capabilities()
