import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { OrgsService } from './orgs.service.js';

const RoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
const Name = z.string().trim().min(1).max(100);
const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes');

export const OrgPatch = z.object({ name: Name });
export const RoleBody = z.object({ role: RoleSchema });
export const InviteBody = z.object({ email: z.email().max(254), role: RoleSchema });
export const TeamBody = z.object({ name: Name, slug: SlugSchema.optional() });
export const TeamPatch = TeamBody.partial();
export const ProjectBody = z.object({
  name: Name,
  slug: SlugSchema.optional(),
  teamId: z.string().nullable().optional(),
});
export const ProjectPatch = ProjectBody.partial();

const Team = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});
const Project = Team.extend({ teamId: z.string().nullable() });
const Member = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  joinedAt: z.string(),
});
const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: RoleSchema,
  expiresAt: z.string(),
});

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class OrgsController {
  constructor(@Inject(OrgsService) private readonly orgs: OrgsService) {}

  @Get()
  @RequirePermission('org:read')
  @ApiZodOk(z.object({ id: z.string(), name: z.string(), slug: z.string(), role: RoleSchema }))
  get(@Org() org: OrgContext) {
    return this.orgs.getOrg(org);
  }

  @Patch()
  @RequirePermission('org:write')
  @ApiZodBody(OrgPatch)
  rename(@Org() org: OrgContext, @Body(new ZodPipe(OrgPatch)) body: z.infer<typeof OrgPatch>) {
    return this.orgs.renameOrg(org, body.name);
  }

  @Get('members')
  @RequirePermission('members:read')
  @ApiZodOk(z.array(Member))
  members(@Org() org: OrgContext) {
    return this.orgs.members(org);
  }

  @Patch('members/:userId')
  @RequirePermission('members:write')
  @ApiZodBody(RoleBody)
  role(
    @Org() org: OrgContext,
    @Param('userId') userId: string,
    @Body(new ZodPipe(RoleBody)) body: z.infer<typeof RoleBody>,
  ) {
    return this.orgs.changeRole(org, userId, body.role);
  }

  @Delete('members/:userId')
  @HttpCode(204)
  @RequirePermission('members:write')
  @ApiNoContentResponse()
  async removeMember(@Org() org: OrgContext, @Param('userId') userId: string) {
    await this.orgs.removeMember(org, userId);
  }

  @Get('invitations')
  @RequirePermission('members:read')
  @ApiZodOk(z.array(Invitation))
  invitations(@Org() org: OrgContext) {
    return this.orgs.invitations(org);
  }

  @Post('invitations')
  @RequirePermission('invites:write')
  @ApiZodBody(InviteBody)
  @ApiZodOk(
    Invitation.extend({ token: z.string(), url: z.string() }),
    'لینک دعوت فقط همین یک بار نشان داده می‌شود',
  )
  invite(@Org() org: OrgContext, @Body(new ZodPipe(InviteBody)) body: z.infer<typeof InviteBody>) {
    return this.orgs.invite(org, body.email, body.role);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission('invites:write')
  @ApiNoContentResponse()
  async revoke(@Org() org: OrgContext, @Param('id') id: string) {
    await this.orgs.revokeInvitation(org, id);
  }

  @Get('teams')
  @RequirePermission('teams:read')
  @ApiZodOk(z.array(Team))
  teams(@Org() org: OrgContext) {
    return this.orgs.teams(org);
  }

  @Post('teams')
  @RequirePermission('teams:write')
  @ApiZodBody(TeamBody)
  @ApiZodOk(Team)
  createTeam(@Org() org: OrgContext, @Body(new ZodPipe(TeamBody)) body: z.infer<typeof TeamBody>) {
    return this.orgs.createTeam(org, body);
  }

  @Patch('teams/:id')
  @RequirePermission('teams:write')
  @ApiZodBody(TeamPatch)
  @ApiZodOk(Team)
  updateTeam(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(TeamPatch)) body: z.infer<typeof TeamPatch>,
  ) {
    return this.orgs.updateTeam(org, id, body);
  }

  @Delete('teams/:id')
  @HttpCode(204)
  @RequirePermission('teams:write')
  @ApiNoContentResponse()
  async deleteTeam(@Org() org: OrgContext, @Param('id') id: string) {
    await this.orgs.deleteTeam(org, id);
  }

  @Get('projects')
  @RequirePermission('projects:read')
  @ApiZodOk(z.array(Project))
  projects(@Org() org: OrgContext) {
    return this.orgs.projects(org);
  }

  @Post('projects')
  @RequirePermission('projects:write')
  @ApiZodBody(ProjectBody)
  @ApiZodOk(Project)
  createProject(
    @Org() org: OrgContext,
    @Body(new ZodPipe(ProjectBody)) body: z.infer<typeof ProjectBody>,
  ) {
    return this.orgs.createProject(org, body);
  }

  @Patch('projects/:id')
  @RequirePermission('projects:write')
  @ApiZodBody(ProjectPatch)
  @ApiZodOk(Project)
  updateProject(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ProjectPatch)) body: z.infer<typeof ProjectPatch>,
  ) {
    return this.orgs.updateProject(org, id, body);
  }

  @Delete('projects/:id')
  @HttpCode(204)
  @RequirePermission('projects:write')
  @ApiNoContentResponse()
  async deleteProject(@Org() org: OrgContext, @Param('id') id: string) {
    await this.orgs.deleteProject(org, id);
  }
}
