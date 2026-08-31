"""add chemex metadata and cancellation fields

Revision ID: a1b2c3d4e5f6
Revises: 37a19caa9d6c
Create Date: 2026-08-31 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '37a19caa9d6c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('analyses', schema=None) as batch_op:
        batch_op.add_column(sa.Column('chemex_image_digest', sa.String(), nullable=True))
        batch_op.add_column(sa.Column('chemex_version', sa.String(), nullable=True))
        batch_op.add_column(sa.Column('celery_task_id', sa.String(), nullable=True))
        batch_op.add_column(sa.Column('cancel_requested', sa.Boolean(), server_default='0', nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('analyses', schema=None) as batch_op:
        batch_op.drop_column('cancel_requested')
        batch_op.drop_column('celery_task_id')
        batch_op.drop_column('chemex_version')
        batch_op.drop_column('chemex_image_digest')
