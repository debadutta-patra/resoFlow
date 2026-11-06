"""add launcher_handle to analyses

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-11-06 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('analyses', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('launcher_handle', sa.JSON(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table('analyses', schema=None) as batch_op:
        batch_op.drop_column('launcher_handle')
