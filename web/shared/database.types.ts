export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      kiosk_sessions: {
        Row: {
          created_at: string | null
          credits: number | null
          ip_address: unknown
          last_active: string | null
          player_id: string
          session_id: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string | null
          credits?: number | null
          ip_address?: unknown
          last_active?: string | null
          player_id: string
          session_id?: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string | null
          credits?: number | null
          ip_address?: unknown
          last_active?: string | null
          player_id?: string
          session_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kiosk_sessions_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      media_items: {
        Row: {
          artist: string | null
          duration: number | null
          fetched_at: string | null
          id: string
          metadata: Json | null
          source_id: string
          source_type: string
          thumbnail: string | null
          title: string
          url: string
        }
        Insert: {
          artist?: string | null
          duration?: number | null
          fetched_at?: string | null
          id?: string
          metadata?: Json | null
          source_id: string
          source_type?: string
          thumbnail?: string | null
          title: string
          url: string
        }
        Update: {
          artist?: string | null
          duration?: number | null
          fetched_at?: string | null
          id?: string
          metadata?: Json | null
          source_id?: string
          source_type?: string
          thumbnail?: string | null
          title?: string
          url?: string
        }
        Relationships: []
      }
      player_memberships: {
        Row: {
          created_at: string
          player_id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          player_id: string
          role?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          player_id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_memberships_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      player_settings: {
        Row: {
          branding: Json | null
          cloudflare_enabled: boolean | null
          cloudflare_r2_public_url: string | null
          coin_per_song: number | null
          freeplay: boolean | null
          karaoke_mode: boolean | null
          kiosk_coin_acceptor_connected: boolean | null
          kiosk_coin_acceptor_device_id: string | null
          kiosk_coin_acceptor_enabled: boolean | null
          kiosk_show_virtual_coin_button: boolean | null
          local_media_enabled: boolean | null
          local_media_path: string | null
          loop: boolean | null
          max_queue_size: number | null
          player_id: string
          player_mode: string | null
          priority_queue_limit: number | null
          search_enabled: boolean | null
          shuffle: boolean | null
          volume: number | null
        }
        Insert: {
          branding?: Json | null
          cloudflare_enabled?: boolean | null
          cloudflare_r2_public_url?: string | null
          coin_per_song?: number | null
          freeplay?: boolean | null
          karaoke_mode?: boolean | null
          kiosk_coin_acceptor_connected?: boolean | null
          kiosk_coin_acceptor_device_id?: string | null
          kiosk_coin_acceptor_enabled?: boolean | null
          kiosk_show_virtual_coin_button?: boolean | null
          local_media_enabled?: boolean | null
          local_media_path?: string | null
          loop?: boolean | null
          max_queue_size?: number | null
          player_id: string
          player_mode?: string | null
          priority_queue_limit?: number | null
          search_enabled?: boolean | null
          shuffle?: boolean | null
          volume?: number | null
        }
        Update: {
          branding?: Json | null
          cloudflare_enabled?: boolean | null
          cloudflare_r2_public_url?: string | null
          coin_per_song?: number | null
          freeplay?: boolean | null
          karaoke_mode?: boolean | null
          kiosk_coin_acceptor_connected?: boolean | null
          kiosk_coin_acceptor_device_id?: string | null
          kiosk_coin_acceptor_enabled?: boolean | null
          kiosk_show_virtual_coin_button?: boolean | null
          local_media_enabled?: boolean | null
          local_media_path?: string | null
          loop?: boolean | null
          max_queue_size?: number | null
          player_id?: string
          player_mode?: string | null
          priority_queue_limit?: number | null
          search_enabled?: boolean | null
          shuffle?: boolean | null
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "player_settings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      player_status: {
        Row: {
          current_media_id: string | null
          last_updated: string | null
          local_url: string | null
          now_playing_index: number | null
          player_id: string
          progress: number | null
          queue_head_position: number | null
          source: string
          state: string
        }
        Insert: {
          current_media_id?: string | null
          last_updated?: string | null
          local_url?: string | null
          now_playing_index?: number | null
          player_id: string
          progress?: number | null
          queue_head_position?: number | null
          source?: string
          state?: string
        }
        Update: {
          current_media_id?: string | null
          last_updated?: string | null
          local_url?: string | null
          now_playing_index?: number | null
          player_id?: string
          progress?: number | null
          queue_head_position?: number | null
          source?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_status_current_media_id_fkey"
            columns: ["current_media_id"]
            isOneToOne: false
            referencedRelation: "media_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_status_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          active_playlist_id: string | null
          created_at: string | null
          display_name: string | null
          id: string
          jukebox_slug: string
          last_heartbeat: string | null
          name: string
          owner_id: string | null
          priority_player_id: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          active_playlist_id?: string | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          jukebox_slug?: string
          last_heartbeat?: string | null
          name: string
          owner_id?: string | null
          priority_player_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          active_playlist_id?: string | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          jukebox_slug?: string
          last_heartbeat?: string | null
          name?: string
          owner_id?: string | null
          priority_player_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "players_priority_player_id_fkey"
            columns: ["priority_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      playlist_items: {
        Row: {
          added_at: string | null
          id: string
          media_item_id: string
          playlist_id: string
          position: number
        }
        Insert: {
          added_at?: string | null
          id?: string
          media_item_id: string
          playlist_id: string
          position: number
        }
        Update: {
          added_at?: string | null
          id?: string
          media_item_id?: string
          playlist_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "playlist_items_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playlist_items_playlist_id_fkey"
            columns: ["playlist_id"]
            isOneToOne: false
            referencedRelation: "playlists_with_counts"
            referencedColumns: ["id"]
          },
        ]
      }
      playlists: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          player_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          player_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          player_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playlists_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      queue: {
        Row: {
          expires_at: string | null
          id: string
          media_item_id: string
          played_at: string | null
          player_id: string
          position: number
          requested_at: string | null
          requested_by: string | null
          type: string
        }
        Insert: {
          expires_at?: string | null
          id?: string
          media_item_id: string
          played_at?: string | null
          player_id: string
          position: number
          requested_at?: string | null
          requested_by?: string | null
          type?: string
        }
        Update: {
          expires_at?: string | null
          id?: string
          media_item_id?: string
          played_at?: string | null
          player_id?: string
          position?: number
          requested_at?: string | null
          requested_by?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "queue_media_item_id_fkey"
            columns: ["media_item_id"]
            isOneToOne: false
            referencedRelation: "media_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "queue_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      r2_files: {
        Row: {
          artist: string | null
          bucket_name: string
          content_type: string | null
          created_at: string | null
          duration: number | null
          etag: string | null
          file_name: string
          id: string
          last_modified: string | null
          object_key: string
          public_url: string
          size_bytes: number | null
          synced_at: string | null
          tags: string[] | null
          thumbnail: string | null
          title: string | null
        }
        Insert: {
          artist?: string | null
          bucket_name: string
          content_type?: string | null
          created_at?: string | null
          duration?: number | null
          etag?: string | null
          file_name: string
          id?: string
          last_modified?: string | null
          object_key: string
          public_url: string
          size_bytes?: number | null
          synced_at?: string | null
          tags?: string[] | null
          thumbnail?: string | null
          title?: string | null
        }
        Update: {
          artist?: string | null
          bucket_name?: string
          content_type?: string | null
          created_at?: string | null
          duration?: number | null
          etag?: string | null
          file_name?: string
          id?: string
          last_modified?: string | null
          object_key?: string
          public_url?: string
          size_bytes?: number | null
          synced_at?: string | null
          tags?: string[] | null
          thumbnail?: string | null
          title?: string | null
        }
        Relationships: []
      }
      system_logs: {
        Row: {
          event: string
          id: number
          payload: Json | null
          player_id: string | null
          severity: string | null
          timestamp: string | null
        }
        Insert: {
          event: string
          id?: number
          payload?: Json | null
          player_id?: string | null
          severity?: string | null
          timestamp?: string | null
        }
        Update: {
          event?: string
          id?: number
          payload?: Json | null
          player_id?: string | null
          severity?: string | null
          timestamp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_logs_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      playlists_with_counts: {
        Row: {
          created_at: string | null
          description: string | null
          id: string | null
          is_active: boolean | null
          item_count: number | null
          name: string | null
          player_id: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playlists_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      can_manage_player_memberships: {
        Args: { p_player_id: string; p_user_id?: string }
        Returns: boolean
      }
      cleanup_expired_queue: { Args: never; Returns: undefined }
      create_jukebox: {
        Args: { p_display_name?: string; p_slug: string }
        Returns: {
          display_name: string
          jukebox_slug: string
          player_id: string
        }[]
      }
      create_or_get_media_item: {
        Args: {
          p_artist?: string
          p_duration?: number
          p_metadata?: Json
          p_source_id: string
          p_source_type: string
          p_thumbnail?: string
          p_title: string
          p_url?: string
        }
        Returns: string
      }
      create_player_for_user: {
        Args: { p_email: string; p_user_id: string }
        Returns: string
      }
      get_my_jukeboxes: {
        Args: never
        Returns: {
          display_name: string
          is_owner: boolean
          jukebox_slug: string
          player_id: string
          role: string
        }[]
      }
      get_my_player_id: { Args: never; Returns: string }
      initialize_player_playlist: {
        Args: { p_player_id: string }
        Returns: {
          loaded_count: number
          playlist_id: string
          playlist_name: string
          success: boolean
        }[]
      }
      is_player_member: {
        Args: { p_player_id: string; p_user_id?: string }
        Returns: boolean
      }
      kiosk_decrement_credit: {
        Args: { p_amount?: number; p_session_id: string }
        Returns: number
      }
      kiosk_increment_credit: {
        Args: { p_amount?: number; p_session_id: string }
        Returns: number
      }
      kiosk_request_enqueue: {
        Args: { p_media_item_id: string; p_session_id: string }
        Returns: string
      }
      load_playlist: {
        Args: {
          p_player_id: string
          p_playlist_id: string
          p_skip_shuffle?: boolean
          p_start_index?: number
        }
        Returns: {
          loaded_count: number
        }[]
      }
      log_event: {
        Args: {
          p_event: string
          p_payload?: Json
          p_player_id: string
          p_severity?: string
        }
        Returns: undefined
      }
      normalize_jukebox_slug: { Args: { p_raw: string }; Returns: string }
      player_heartbeat: { Args: { p_player_id: string }; Returns: undefined }
      provision_default_playlist_for_player: {
        Args: { p_player_id: string }
        Returns: string
      }
      queue_add: {
        Args: {
          p_media_item_id: string
          p_player_id: string
          p_requested_by?: string
          p_type?: string
        }
        Returns: string
      }
      queue_clear: {
        Args: { p_player_id: string; p_type?: string }
        Returns: undefined
      }
      queue_next:
        | {
            Args: { p_player_id: string }
            Returns: {
              duration: number
              media_item_id: string
              title: string
              url: string
            }[]
          }
        | {
            Args: { p_expected_media_id?: string; p_player_id: string }
            Returns: {
              duration: number
              media_item_id: string
              title: string
              url: string
            }[]
          }
      queue_remove: { Args: { p_queue_id: string }; Returns: undefined }
      queue_reorder:
        | {
            Args: {
              p_player_id: string
              p_queue_ids: string[]
              p_type?: string
            }
            Returns: undefined
          }
        | {
            Args: {
              p_player_id: string
              p_queue_ids: string[]
              p_start_position: number
              p_type: string
            }
            Returns: undefined
          }
      queue_reorder_wrapper: {
        Args: { p_player_id: string; p_queue_ids: string[]; p_type?: string }
        Returns: undefined
      }
      queue_shuffle: {
        Args: { p_player_id: string; p_type?: string }
        Returns: undefined
      }
      queue_skip: { Args: { p_player_id: string }; Returns: undefined }
      resolve_jukebox_slug: {
        Args: { p_slug: string }
        Returns: {
          display_name: string
          jukebox_slug: string
          player_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
