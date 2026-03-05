import { create } from 'zustand'
import type { Project, ProjectCreate } from '../types'
import * as projectAPI from '../api/projects'

interface ProjectStore {
  projects: Project[]
  currentProjectId: string | null
  loading: boolean

  loadProjects: () => Promise<void>
  createProject: (data: ProjectCreate) => Promise<Project>
  updateProject: (projectId: string, data: Partial<ProjectCreate>) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  setCurrentProject: (projectId: string | null) => void
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProjectId: null,
  loading: false,

  loadProjects: async () => {
    set({ loading: true })
    try {
      const projects = await projectAPI.listProjects()
      set({ projects: Array.isArray(projects) ? projects : [] })
    } catch (error) {
      console.error('Failed to load projects:', error)
      set({ projects: [] })
    } finally {
      set({ loading: false })
    }
  },

  createProject: async (data: ProjectCreate) => {
    try {
      const project = await projectAPI.createProject(data)
      set((state) => ({
        projects: [...state.projects, project],
      }))
      return project
    } catch (error) {
      console.error('Failed to create project:', error)
      throw error
    }
  },

  updateProject: async (projectId: string, data: Partial<ProjectCreate>) => {
    try {
      await projectAPI.updateProject(projectId, data)
      await get().loadProjects()
    } catch (error) {
      console.error('Failed to update project:', error)
      throw error
    }
  },

  deleteProject: async (projectId: string) => {
    try {
      await projectAPI.deleteProject(projectId)
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
        currentProjectId:
          state.currentProjectId === projectId ? null : state.currentProjectId,
      }))
    } catch (error) {
      console.error('Failed to delete project:', error)
      throw error
    }
  },

  setCurrentProject: (projectId: string | null) => {
    set({ currentProjectId: projectId })
  },
}))
