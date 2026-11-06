"""add results bundle fields to analyses

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-11-06 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('analyses', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('bundle_status', sa.String(), nullable=True, server_default='NONE')
        )
        batch_op.add_column(
            sa.Column('summary_redchi', sa.Float(), nullable=True)
        )
        batch_op.add_column(
            sa.Column('summary_n_residues', sa.Integer(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table('analyses', schema=None) as batch_op:
        batch_op.drop_column('summary_n_residues')
        batch_op.drop_column('summary_redchi')
        batch_op.drop_column('bundle_status')
